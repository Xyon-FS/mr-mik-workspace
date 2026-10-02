import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { realpath, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCodeBinary, childEnvironment } from './agents.mjs';
import { validSessionId, openCodeVersion } from './opencode.mjs';
import { OpenCodeV2Transfer, isV2Transfer, validateV2Transfer, v2Members, v2Hash, v2Relation } from './opencode-v2-transfer.mjs';

const execute = promisify(execFile);
const canonical = value => JSON.stringify(sort(value));
export function assertOpenCodeDatabaseSchema(db) {
  // V2 migrations can retain V1 tables. Presence alone must not make the legacy
  // reader export/delete stale conversations instead of current data.
  // This is a format check, not a CLI version pin.
  if (db.prepare('PRAGMA table_info("session_v2")').all().length) throw new Error('OpenCode V2 session storage requires the V2 transfer adapter. Legacy transfer/deletion stopped before mutation.');
  // Require only the fields we actually inspect; extra tables/columns are OK.
  // Never infer compatibility from a release number or migrate a user's DB.
  for (const [table, columns] of [
    ['session', ['id', 'parent_id', 'project_id', 'directory', 'title', 'time_updated']],
    ['message', ['id', 'session_id', 'data', 'time_created']],
    ['part', ['id', 'session_id', 'message_id', 'data']],
    ['todo', ['session_id', 'content', 'status', 'priority', 'position']],
  ]) {
    const names = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
    if (columns.some(column => !names.includes(column))) throw new Error('Unsupported native OpenCode database schema. Transfer/deletion stopped; use light export or update the Mr. Mik adapter.');
  }
}
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export function validateOpenCode(data, id = data?.info?.id, { portable = true, allowParent = false } = {}) {
  if (isV2Transfer(data)) return validateV2Transfer(data, id, { portable });
  if (!data || Object.keys(data).some(key => !['info', 'messages', 'todos', 'children'].includes(key)) || data.info?.parentID && !allowParent) throw new Error('Unsupported OpenCode session family or envelope.');
  if (data.todos != null && (!Array.isArray(data.todos) || data.todos.length > 5000 || data.todos.some((item, index) => !item || Object.keys(item).some(key => !['content', 'status', 'priority', 'position'].includes(key)) || typeof item.content !== 'string' || item.content.length > 64000 || !['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status) || !['low', 'medium', 'high'].includes(item.priority) || item.position !== index))) throw new Error('Invalid OpenCode session task list.');
  if (!validSessionId(id) || data?.info?.id !== id || !Array.isArray(data.messages) || data.messages.length > 100000 || typeof data.info.title !== 'string' || typeof data.info.slug !== 'string' || typeof data.info.version !== 'string' || !Number.isFinite(data.info.time?.created) || !Number.isFinite(data.info.time?.updated)) throw new Error('Invalid native OpenCode session data.');
  const ids = new Set();
  for (const message of data.messages) {
    if (!/^msg[a-zA-Z0-9_-]{1,160}$/.test(message?.info?.id || '') || ids.has(message.info.id) || message.info.sessionID !== id || !['user', 'assistant'].includes(message.info.role) || !Number.isFinite(message.info.time?.created) || !Array.isArray(message.parts)) throw new Error('Invalid OpenCode message identity.');
    ids.add(message.info.id);
    for (const part of message.parts) {
      if (!/^prt[a-zA-Z0-9_-]{1,160}$/.test(part?.id || '') || ids.has(part.id) || part.sessionID !== id || part.messageID !== message.info.id || typeof part.type !== 'string') throw new Error('Invalid OpenCode part identity.');
      ids.add(part.id);
      if (portable && part.type === 'file' && !/^data:/i.test(part.url || '')) throw new Error('OpenCode has an external file attachment. Embed it before full export; light export remains available.');
      for (const attachment of part.state?.attachments || []) if (portable && !/^data:/i.test(attachment.url || '')) throw new Error('OpenCode has an external tool attachment; full transfer would be incomplete.');
    }
  }
  if (allowParent && data.children !== undefined) throw new Error('Nested OpenCode family envelopes are unsupported.');
  if (!allowParent) validateFamily(data, portable);
  return data;
}

// A flat, bounded family envelope keeps official per-session JSON unchanged.
export function openCodeMembers(data) {
  if (!data) return [];
  if (isV2Transfer(data)) { validateV2Transfer(data, data.info?.id, { portable: false }); return v2Members(data); }
  if (data.children !== undefined && (!Array.isArray(data.children) || data.children.length >= 64)) throw new Error('OpenCode family exceeds the supported 64-session limit.');
  const all = [data, ...(data.children || [])], byId = new Map(all.map(member => [member?.info?.id, member]));
  if (byId.size !== all.length || !validSessionId(data.info?.id)) throw new Error('Duplicate or invalid OpenCode family identity.');
  const ordered = [], queue = [[data, 0]], seen = new Set();
  while (queue.length) {
    const [member, depth] = queue.shift();
    if (depth > 16 || seen.has(member.info.id)) throw new Error('Invalid or excessively deep OpenCode family.');
    seen.add(member.info.id); ordered.push(member);
    for (const child of all.slice(1).filter(candidate => candidate.info?.parentID === member.info.id).sort((a, b) => a.info.id.localeCompare(b.info.id))) queue.push([child, depth + 1]);
  }
  if (ordered.length !== all.length) throw new Error('OpenCode family has a missing parent or a cycle.');
  return ordered;
}
function validateFamily(data, portable) {
  if (typeof data.info.directory !== 'string') throw new Error('Invalid OpenCode working folder.');
  const members = openCodeMembers(data), identities = new Set(), sessionIds = new Set(members.map(member => member.info.id));
  const folder = path.resolve(data.info.directory || '').toLowerCase();
  for (const member of members) {
    if (member !== data) {
      validateOpenCode(member, member.info.id, { portable, allowParent: true });
      if (!validSessionId(member.info.parentID) || path.resolve(member.info.directory || '').toLowerCase() !== folder) throw new Error('OpenCode child sessions must belong to this family and the same working folder.');
    }
    for (const message of member.messages) {
      for (const id of [message.info.id, ...message.parts.map(part => part.id)]) {
        if (identities.has(id)) throw new Error('Duplicate OpenCode message or part identity across the family.');
        identities.add(id);
      }
      for (const part of message.parts) if (part.type === 'tool' && part.tool === 'task') {
        const target = part.state?.metadata?.sessionId;
        if (target && !sessionIds.has(target)) throw new Error('OpenCode has a subagent reference outside this family. Use light export.');
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 64 * 1024 ** 2) throw new Error('OpenCode family exceeds the supported 64 MB limit.');
}
function comparable(data) {
  if (!data) return null;
  const value = structuredClone(data);
  value.todos ||= [];
  for (const key of ['projectID', 'directory', 'path', 'workspaceID', 'permission', 'share']) delete value.info[key];
  delete value.info.time.updated;
  if (value.children) value.children = value.children.map(comparable).sort((a, b) => a.info.id.localeCompare(b.info.id));
  for (const message of value.messages) if (message.info.path) delete message.info.path;
  return value;
}
export const openCodeHash = data => isV2Transfer(data) ? v2Hash(data) : data ? createHash('sha256').update(canonical(comparable(data))).digest('hex') : null;
export const openCodeIdentities = member => [member.info.id, ...member.messages.flatMap(message => isV2Transfer(member) ? [message.id] : [message.info.id, ...message.parts.map(part => part.id)])];
export function parseOpenCode(text) {
  try { return JSON.parse(text); } catch { throw new Error('Native OpenCode session JSON is invalid. Transcript fragments are not displayed.'); }
}
function sessionRelation(local, incoming) {
  if (!local) return 'new';
  const a = comparable(local), b = comparable(incoming);
  if (a.info.parentID !== b.info.parentID || canonical(a.info.revert) !== canonical(b.info.revert)) return 'conflict';
  if (canonical(a.messages) === canonical(b.messages)) return 'identical';
  if (a.messages.length === b.messages.length) return 'conflict';
  const [short, long] = a.messages.length < b.messages.length ? [a, b] : [b, a];
  if (!short.messages.length || short.messages.some((message, index) => canonical(message) !== canonical(long.messages[index]))) return 'conflict';
  return a.messages.length < b.messages.length ? 'update' : 'local-newer';
}
export function openCodeRelation(local, incoming) {
  if (isV2Transfer(local) || isV2Transfer(incoming)) return v2Relation(local, incoming);
  if (!local) return 'new';
  const a = new Map(openCodeMembers(local).map(member => [member.info.id, member]));
  const b = new Map(openCodeMembers(incoming).map(member => [member.info.id, member]));
  if (local.info.id !== incoming.info.id) return 'conflict';
  const relations = [...b.values()].map(member => sessionRelation(a.get(member.info.id), member));
  if ([...a.keys()].some(id => !b.has(id))) relations.push('local-newer');
  if (relations.includes('conflict')) return 'conflict';
  const newer = relations.some(value => ['new', 'update'].includes(value)), older = relations.includes('local-newer');
  return newer && older ? 'conflict' : newer ? 'update' : older ? 'local-newer' : 'identical';
}

export class OpenCodeTransfer {
  constructor(repo, { env, binary, family } = {}) { this.repo = repo; this.env = env; this.binary = binary; this.family = family; this.revisions = new Map(); }
  v2() {
    let family = this.family;
    if (!family) {
      try { family = Number(openCodeVersion(this.env || process.env).split('.')[0]) >= 2 ? 2 : 1; }
      catch { return null; } // Legacy commands still fail safely if no CLI exists.
    }
    return family === 2 ? new OpenCodeV2Transfer(this.repo, { env: this.env, binary: this.binary }) : null;
  }
  revision(db, id) {
    const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!row) return null;
    return canonical([row, db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY id').all(id), db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY id').all(id), db.prepare('SELECT * FROM todo WHERE session_id = ? ORDER BY position').all(id)]);
  }
  async command(args) {
    const source = this.env || childEnvironment(this.repo);
    const env = Object.fromEntries(Object.entries(source).filter(([key]) => /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_\w+|OPENCODE_DB|OPENCODE_DISABLE_CHANNEL_DB)$/i.test(key)));
    Object.assign(env, { OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_CONFIG_CONTENT: '{}' });
    const binary = this.binary || openCodeBinary();
    if (!binary.file || /\.(?:cmd|bat|ps1)$/i.test(binary.file)) throw new Error('Native OpenCode binary is required for session transfer.');
    const run = value => execute(binary.file, [...binary.args, ...value, '--pure'], { cwd: this.repo, env, windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 ** 2 });
    let temp;
    try {
      if (['import', 'export'].includes(args[0]) || args[0] === 'session' && args[1] === 'delete') {
        // db path is an instance-free native command. Keep that exact database,
        // but do not load personal accounts/settings or project config: OpenCode
        // may otherwise auto-write $schema to a user's existing settings file.
        const database = (await run(['db', 'path'])).stdout.trim();
        if (!path.isAbsolute(database)) throw new Error('Invalid native database path.');
        temp = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-command-'));
        for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[key] = path.join(temp, key); await mkdir(env[key]); }
        env.OPENCODE_DB = database; env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
      }
      return (await run(args)).stdout;
    } catch { throw new Error('Native OpenCode session command failed. No credentials or command output are displayed.'); }
    finally { if (temp) await rm(temp, { recursive: true, force: true }); }
  }
  async database() {
    const file = await realpath((await this.command(['db', 'path'])).trim());
    if (!(await stat(file)).isFile()) throw new Error('Native OpenCode database is unavailable.');
    // SQL is inspection-only; native CLI commands own every mutation.
    const db = new DatabaseSync(file, { readOnly: true });
    try { assertOpenCodeDatabaseSchema(db); }
    catch (error) { db.close(); throw error; }
    return db;
  }
  familyRows(db, id) {
    const root = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
    if (!root) {
      if (db.prepare('SELECT id FROM session WHERE parent_id = ? LIMIT 1').get(id)) throw new Error('OpenCode has orphaned child sessions; repair it natively first.');
      return [];
    }
    if (root.parent_id) throw new Error('Select the main OpenCode conversation, not an isolated child session.');
    const rows = [], queue = [[root, 0]], seen = new Set();
    while (queue.length) {
      const [row, depth] = queue.shift();
      if (depth > 16 || rows.length >= 64 || seen.has(row.id)) throw new Error('Invalid or excessively large OpenCode family.');
      seen.add(row.id); rows.push(row);
      if (path.resolve(row.directory).toLowerCase() !== path.resolve(root.directory).toLowerCase()) throw new Error('OpenCode child sessions use different working folders. Use light export.');
      const children = db.prepare('SELECT * FROM session WHERE parent_id = ? ORDER BY id LIMIT 65').all(row.id);
      if (rows.length + queue.length + children.length > 64) throw new Error('OpenCode family exceeds the supported 64-session limit.');
      for (const child of children) queue.push([child, depth + 1]);
    }
    return rows;
  }
  familyRevision(db, id) {
    const rows = this.familyRows(db, id);
    return rows.length ? canonical(rows.map(row => [row.id, this.revision(db, row.id)])) : null;
  }
  async read(id) {
    const v2 = this.v2(); if (v2) return v2.read(id);
    if (!validSessionId(id)) throw new Error('Invalid OpenCode conversation ID.');
    const db = await this.database();
    let rows, revision;
    try {
      rows = this.familyRows(db, id);
      if (!rows.length) { this.revisions.delete(id); return null; }
      revision = this.familyRevision(db, id);
    } finally { db.close(); }
    const members = []; let bytes = 0;
    for (const row of rows) {
      const text = await this.command(['export', row.id]); bytes += Buffer.byteLength(text);
      if (bytes > 64 * 1024 ** 2) throw new Error('OpenCode family exceeds the supported 64 MB limit.');
      members.push(validateOpenCode(parseOpenCode(text), row.id, { portable: false, allowParent: true }));
    }
    const check = await this.database();
    try {
      if (this.familyRevision(check, id) !== revision) throw new Error('OpenCode family changed while being read. Close its CLI and retry.');
      for (const member of members) member.todos = check.prepare('SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position').all(member.info.id);
    } finally { check.close(); }
    const [data, ...children] = members;
    if (children.length) data.children = children;
    validateOpenCode(data, id, { portable: false });
    this.revisions.set(id, revision); return data;
  }
  async inspect(data, local) {
    const v2 = this.v2();
    if (v2) { if (!isV2Transfer(data)) throw new Error('V1 native conversation archives require a V1 CLI; automatic cross-format conversion is not supported.'); return v2.inspect(data, local); }
    if (isV2Transfer(data)) throw new Error('A V2 conversation archive requires a V2 CLI.');
    const id = data.info.id, members = openCodeMembers(data), localIds = new Set(openCodeMembers(local).map(member => member.info.id));
    const db = await this.database();
    try {
      if (this.familyRevision(db, id) !== (this.revisions.get(id) ?? null)) throw new Error('OpenCode family changed before native import.');
      for (const member of members) {
        const existing = db.prepare('SELECT id FROM session WHERE id = ?').get(member.info.id);
        if (existing && !localIds.has(member.info.id)) throw new Error('An OpenCode child ID belongs to another conversation family.');
        for (const message of member.messages) {
          const owner = db.prepare('SELECT session_id FROM message WHERE id = ?').get(message.info.id);
          if (owner && owner.session_id !== member.info.id) throw new Error('An OpenCode message ID belongs to another conversation.');
          for (const part of message.parts) {
            const owner = db.prepare('SELECT session_id FROM part WHERE id = ?').get(part.id);
            if (owner && owner.session_id !== member.info.id) throw new Error('An OpenCode part ID belongs to another conversation.');
          }
        }
      }
    } finally { db.close(); }
  }
  async write(data, cwd, expectedHash, options) {
    const v2 = this.v2(); if (v2) return v2.write(data, cwd, expectedHash, options);
    if (isV2Transfer(data)) throw new Error('A V2 conversation archive requires a V2 CLI.');
    validateOpenCode(data);
    const id = data.info.id, members = openCodeMembers(data);
    const working = await realpath(cwd);
    if (!(await stat(working)).isDirectory()) throw new Error('Relink this OpenCode chat to an existing working folder.');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-import-'));
    try {
      const files = [];
      for (const member of members) {
        const file = path.join(temp, member.info.id + '.json');
        await writeFile(file, JSON.stringify({ info: { ...member.info, permission: undefined, share: undefined, workspaceID: undefined }, messages: member.messages }), { mode: 0o600 });
        files.push(file);
      }
      // Validate the entire family before touching the destination.
      const env = { ...(this.env || childEnvironment(this.repo)), OPENCODE_DB: path.join(temp, 'validation.db') };
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[key] = path.join(temp, key); await mkdir(env[key]); }
      const checker = new OpenCodeTransfer(temp, { env, binary: this.binary });
      for (const file of files) await checker.command(['import', file]);
      const decoded = await checker.read(id);
      if (openCodeRelation(decoded, data) !== 'identical') throw new Error('Native OpenCode rejected part of this conversation family.');
      const local = await this.read(id);
      if (openCodeHash(local) !== expectedHash) throw new Error('OpenCode conversation changed. Close its CLI and preview again.');
      if (!['new', 'update', 'identical'].includes(openCodeRelation(local, data))) throw new Error('OpenCode native import cannot replace divergent or newer local conversations. Keep the local chat.');
      await this.inspect(data, local);
      const importer = new OpenCodeTransfer(working, { env: this.env || childEnvironment(this.repo), binary: this.binary });
      for (const file of files) await importer.command(['import', file]);
      const result = await this.read(id);
      if (!result || openCodeMembers(result).some(member => path.resolve(member.info.directory) !== working) || openCodeRelation(result, data) !== 'identical') throw new Error('Native OpenCode import did not match the expected family. Import stopped; inspect its backup before retrying.');
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  async remove(id, expectedHash) {
    const v2 = this.v2(); if (v2) return v2.remove(id, expectedHash);
    const data = await this.read(id);
    if (!expectedHash || !data || openCodeHash(data) !== expectedHash) throw new Error('OpenCode conversation changed; review deletion again.');
    const revision = this.revisions.get(id), ids = openCodeMembers(data).map(member => member.info.id);
    const db = await this.database();
    try {
      if (this.familyRevision(db, id) !== revision) throw new Error('OpenCode family changed; review deletion again.');
    } finally { db.close(); }
    await this.command(['session', 'delete', id]);
    const check = await this.database();
    try {
      if (ids.some(key => check.prepare('SELECT id FROM session WHERE id = ?').get(key))) throw new Error('Native OpenCode deletion was not completed. The Mr. Mik History entry has been retained.');
    } finally { check.close(); }
  }
}
