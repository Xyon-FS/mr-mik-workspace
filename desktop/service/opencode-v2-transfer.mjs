import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, open, rm, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openCodeBinary, childEnvironment } from './agents.mjs';
import { validSessionId } from './opencode.mjs';

const execute = promisify(execFile);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
export const isV2Transfer = data => data?.format === 'opencode-v2';

export function v2Members(data) {
  if (!data) return [];
  if (data.children !== undefined && (!Array.isArray(data.children) || data.children.length >= 64)) throw new Error('V2 family exceeds the supported 64-session limit.');
  const all = [data, ...(data.children || [])], ids = new Set(all.map(member => member?.info?.id));
  if (ids.size !== all.length || [...ids].some(id => !validSessionId(id))) throw new Error('Invalid V2 family identity.');
  const ordered = [], queue = [[data, 0]];
  while (queue.length) {
    const [member, depth] = queue.shift();
    if (depth > 16 || ordered.includes(member)) throw new Error('V2 family is cyclic or too deep.');
    ordered.push(member);
    for (const child of all.slice(1).filter(child => child.info.parentID === member.info.id).sort((a, b) => a.info.id.localeCompare(b.info.id))) queue.push([child, depth + 1]);
  }
  if (ordered.length !== all.length) throw new Error('V2 family has a missing parent or cycle.');
  return ordered;
}
export function validateV2Transfer(data, id = data?.info?.id, { portable = true, allowParent = false, allowIncomplete = false } = {}) {
  if (!isV2Transfer(data) || Object.keys(data).some(key => !['format', 'info', 'messages', ...(!allowParent ? ['children'] : [])].includes(key)) || !validSessionId(id) || data.info?.id !== id || !Array.isArray(data.messages) || data.messages.length > 100000 || typeof data.info.location?.directory !== 'string' || !Number.isFinite(data.info.time?.created) || !Number.isFinite(data.info.time?.updated)) throw new Error('Invalid native OpenCode V2 transfer envelope.');
  if (data.info.parentID && !allowParent || data.info.fork || data.info.revert) throw new Error('V2 parent/fork/revert dependencies are not portable in this envelope.');
  const seen = new Set();
  for (const message of data.messages) {
    if (!/^msg[a-zA-Z0-9_-]{1,160}$/.test(message?.id || '') || seen.has(message.id) || !['user', 'assistant', 'system', 'synthetic', 'skill', 'shell', 'compaction', 'idle', 'agent-switched', 'model-switched'].includes(message.type) || !Number.isFinite(message.time?.created)) throw new Error('Invalid native V2 message identity/type. Location-switch histories require an explicit cross-folder adapter.');
    seen.add(message.id);
    if (message.type === 'assistant' && !Number.isFinite(message.time.completed) || ['shell', 'compaction'].includes(message.type) && message.status === 'running') throw new Error('V2 transfer requires settled messages.');
    if (message.type === 'assistant' && !Array.isArray(message.content)) throw new Error('Invalid V2 assistant content.');
    if (message.files !== undefined && !Array.isArray(message.files)) throw new Error('Invalid V2 file attachments.');
    for (const file of message.files || []) {
      if (typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mime || '') || !['inline', 'uri'].includes(file.source?.type) || file.source.type === 'uri' && typeof file.source.uri !== 'string') throw new Error('Invalid V2 external/inline file attachment.');
      if (portable && file.source.type !== 'inline') throw new Error('V2 external file provenance must be normalized before full export.');
      if (Buffer.byteLength(file.data, 'base64') > 16 * 1024 ** 2) throw new Error('V2 file attachment exceeds the 16 MB limit.');
    }
    for (const content of message.content || []) if (content.type === 'tool') {
      if (['running', 'streaming'].includes(content.state?.status)) throw new Error('V2 tool execution is not settled.');
      if (content.state?.content !== undefined && !Array.isArray(content.state.content)) throw new Error('Invalid V2 tool content.');
      for (const item of content.state?.content || []) {
        if (!['text', 'file'].includes(item?.type) || item.type === 'text' && typeof item.text !== 'string' || item.type === 'file' && (typeof item.uri !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(item.mime || ''))) throw new Error('Invalid V2 tool attachment.');
        if (portable && item.type === 'file' && !/^data:/i.test(item.uri)) throw new Error('V2 external tool attachments require explicit export review.');
        if (item.type === 'file' && /^data:/i.test(item.uri) && (!/^data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(item.uri) || Buffer.byteLength(item.uri.slice(item.uri.indexOf(',') + 1), 'base64') > 16 * 1024 ** 2)) throw new Error('Invalid or oversized V2 embedded tool attachment.');
      }
    }
  }
  if (!allowParent) {
    const members = v2Members(data), identities = new Set(), ids = new Set(members.map(member => member.info.id));
    for (const member of members) {
      if (member !== data) {
        validateV2Transfer(member, member.info.id, { portable, allowParent: true });
        if (path.resolve(member.info.location.directory).toLowerCase() !== path.resolve(data.info.location.directory).toLowerCase()) throw new Error('V2 child sessions must use the same working folder.');
      }
      for (const message of member.messages) {
        if (identities.has(message.id)) throw new Error('Duplicate V2 message identity across family.');
        identities.add(message.id);
        for (const content of message.content || []) if (content.type === 'tool') {
          const target = content.state?.metadata?.sessionId ?? content.state?.metadata?.sessionID;
          if (!allowIncomplete && target && !ids.has(target) || content.name === 'task' && content.state?.status === 'completed' && !validSessionId(target)) throw new Error('V2 subagent dependency is outside this family or unrecognized.');
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 64 * 1024 ** 2) throw new Error('V2 transfer exceeds the 64 MB limit.');
  return data;
}
function comparable(data) {
  if (!data) return null;
  const value = structuredClone(data);
  for (const key of ['projectID', 'location', 'subpath', 'permissions', 'share', 'slug', 'version']) delete value.info[key];
  delete value.info.time.updated;
  // Prompt file bytes are already historical data; URI provenance is not a
  // content difference after portable normalization. Never resolve tool URIs
  // here: comparing them with embedded bytes would require an external read.
  for (const message of value.messages) for (const file of message.files || []) if (typeof file.data === 'string' && ['inline', 'uri'].includes(file.source?.type)) file.source = { type: 'inline' };
  if (value.children) value.children = value.children.map(comparable).sort((a, b) => a.info.id.localeCompare(b.info.id));
  return value;
}
export const v2Hash = data => data ? createHash('sha256').update(canonical(comparable(data))).digest('hex') : null;
function memberRelation(local, incoming) {
  if (!local) return 'new';
  if (!isV2Transfer(local) || !isV2Transfer(incoming) || local.info.id !== incoming.info.id) return 'conflict';
  const a = comparable(local), b = comparable(incoming);
  delete a.children; delete b.children;
  if ((a.info.parentID ?? null) !== (b.info.parentID ?? null)) return 'conflict';
  if (canonical(a) === canonical(b)) return 'identical';
  const [short, long] = a.messages.length < b.messages.length ? [a, b] : [b, a];
  if (!short.messages.length || short.messages.length === long.messages.length || short.messages.some((message, index) => canonical(message) !== canonical(long.messages[index]))) return 'conflict';
  return a.messages.length > b.messages.length ? 'local-newer' : 'update';
}
export function v2Relation(local, incoming) {
  if (!local) return 'new';
  if (!isV2Transfer(local) || !isV2Transfer(incoming) || local.info.id !== incoming.info.id) return 'conflict';
  const a = new Map(v2Members(local).map(member => [member.info.id, member])), b = new Map(v2Members(incoming).map(member => [member.info.id, member]));
  const relations = [...b.values()].map(member => memberRelation(a.get(member.info.id), member));
  const longerLocal = [...a.keys()].some(id => !b.has(id)) || relations.includes('local-newer');
  const longerIncoming = relations.some(value => ['new', 'update'].includes(value));
  if (relations.includes('conflict') || longerLocal && longerIncoming) return 'conflict';
  return longerLocal ? 'local-newer' : longerIncoming ? 'update' : 'identical';
}
const policies = data => v2Members(data).map(member => [member.info.id, member.info.permissions ?? null, member.info.share ?? null]).sort((a, b) => a[0].localeCompare(b[0]));
const exactSubset = (current, planned) => {
  const expected = new Map(v2Members(planned).map(member => [member.info.id, member]));
  return v2Members(current).every(member => expected.has(member.info.id) && memberRelation(member, expected.get(member.info.id)) === 'identical' && canonical(member.info.permissions ?? null) === canonical(expected.get(member.info.id).info.permissions ?? null));
};

export class OpenCodeV2Transfer {
  constructor(repo, { env, binary } = {}) { Object.assign(this, { repo, env, binary }); }
  async raw(args, env, cwd = this.repo) {
    const binary = this.binary || openCodeBinary(this.env || process.env);
    if (!binary.file || /\.(cmd|bat|ps1)$/i.test(binary.file)) throw new Error('A native V2 executable is required for transfer.');
    try { return (await execute(binary.file, [...binary.args, ...args], { cwd, env, windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 ** 2 })).stdout; }
    catch { throw new Error('Native V2 transfer command failed. No transcript or authentication output is displayed.'); }
  }
  environment() {
    return Object.fromEntries(Object.entries(this.env || childEnvironment(this.repo)).filter(([key, value]) => value != null && /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_\w+|OPENCODE_DB|OPENCODE_DISABLE_CHANNEL_DB|OPENCODE_TEST_HOME)$/i.test(key)));
  }
  async databasePath() {
    const file = (await this.raw(['debug', 'paths', 'db'], this.environment())).trim();
    if (!path.isAbsolute(file)) throw new Error('Native V2 database path is invalid.');
    return file;
  }
  async inspectDb(id, callback, { member = false } = {}) {
    const file = await this.databasePath();
    if (!await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return callback(null);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const [table, columns] of [['session_v2', ['id', 'parent_id', 'fork_session_id', 'directory', 'time_suspended']], ['session_message', ['id', 'session_id', 'data', 'type', 'seq']], ['session_pending', ['session_id']], ['session_inbox', ['session_id']]]) {
        const found = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
        if (columns.some(column => !found.includes(column))) throw new Error('Native V2 transfer storage schema is unrecognized. No mutation was attempted.');
      }
      const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(id);
      if (row) {
        if (row.parent_id && !member) throw new Error('Export or delete this V2 child through its main family conversation.');
        if (row.time_suspended || db.prepare('SELECT session_id FROM session_pending WHERE session_id = ? LIMIT 1').get(id) || db.prepare('SELECT session_id FROM session_inbox WHERE session_id = ? LIMIT 1').get(id)) throw new Error('V2 conversation has active or queued work. Close its CLI and settle the conversation first.');
      }
      return callback(db, row);
    } finally { db.close(); }
  }
  async command(args, directory) {
    const env = this.environment(), database = await this.databasePath();
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-transfer-command-'));
    try {
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_TEST_HOME']) { env[key] = path.join(temp, key); await mkdir(env[key]); }
      Object.assign(env, { OPENCODE_DB: database, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_CONTENT: '{"plugins":["-*"],"snapshots":false}' });
      return await this.raw([...args, '--standalone', ...(directory ? ['--directory', directory] : [])], env, temp);
    } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  async read(id, { allowIncomplete = false } = {}) {
    if (!validSessionId(id)) throw new Error('Invalid V2 session ID.');
    const snapshot = (db, row) => {
      if (!row) return null;
      const members = [], queue = [[row, 0]];
      while (queue.length) {
        const [current, depth] = queue.shift();
        if (members.length >= 64 || depth > 16 || members.some(member => member.row.id === current.id)) throw new Error('V2 family exceeds supported bounds or is cyclic.');
        if (path.resolve(current.directory).toLowerCase() !== path.resolve(row.directory).toLowerCase()) throw new Error('V2 family crosses working folders.');
        if (current.time_suspended || db.prepare('SELECT session_id FROM session_pending WHERE session_id = ? LIMIT 1').get(current.id) || db.prepare('SELECT session_id FROM session_inbox WHERE session_id = ? LIMIT 1').get(current.id)) throw new Error('V2 family has active or queued work. Close its CLIs first.');
        const messages = db.prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq').all(current.id);
        members.push({ row: current, count: messages.length, revision: canonical([current, messages]) });
        for (const child of db.prepare('SELECT * FROM session_v2 WHERE parent_id = ? ORDER BY id').all(current.id)) queue.push([child, depth + 1]);
      }
      return members;
    };
    const before = await this.inspectDb(id, snapshot);
    if (!before) return null;
    const members = []; let serializedBytes = 0;
    for (const item of before) {
      let native; try { native = JSON.parse(await this.command(['session', 'export', item.row.id])); } catch { throw new Error('Native V2 export was not recognized.'); }
      serializedBytes += Buffer.byteLength(JSON.stringify(native));
      if (serializedBytes > 64 * 1024 ** 2) throw new Error('V2 family exceeds the supported 64 MB limit.');
      if (native.info?.fork) {
        if (native.info.metadata?.mrMikFork !== undefined) throw new Error('Reserved Mik fork provenance conflicts with existing metadata.');
        native.info.metadata = { ...native.info.metadata, mrMikFork: native.info.fork }; delete native.info.fork;
      }
      if (native.messages?.length !== item.count) throw new Error('Native V2 export omitted unsettled history. Settle the conversation before full transfer.');
      members.push({ format: 'opencode-v2', ...native });
    }
    const data = members[0]; if (members.length > 1) data.children = members.slice(1);
    validateV2Transfer(data, id, { portable: false, allowIncomplete });
    const after = await this.inspectDb(id, snapshot);
    if (canonical(after) !== canonical(before)) throw new Error('V2 family changed while exporting. Retry after closing its CLIs.');
    return data;
  }
  async inspect(data, local) {
    validateV2Transfer(data);
    await this.inspectDb(data.info.id, (db, row) => {
      if (row && !local) throw new Error('V2 conversation appeared since preview.');
      for (const member of v2Members(data)) {
        const ownerSession = db?.prepare('SELECT parent_id FROM session_v2 WHERE id = ?').get(member.info.id);
        if (member !== data && ownerSession && ownerSession.parent_id !== member.info.parentID) throw new Error('A V2 descendant ID belongs to another family.');
        for (const message of member.messages) {
          const owner = db?.prepare('SELECT session_id FROM session_message WHERE id = ?').get(message.id);
          if (owner && owner.session_id !== member.info.id) throw new Error('A V2 message ID belongs to another conversation.');
        }
      }
    });
  }
  async validateImport(file, data, working, temp, name) {
    const checker = new OpenCodeV2Transfer(temp, { env: { ...this.environment(), OPENCODE_DB: path.join(temp, `${name}.db`) }, binary: this.binary });
    for (const item of Array.isArray(file) ? file : [file]) await checker.command(['session', 'import', item], working);
    const checked = await checker.read(data.info.id);
    if (v2Relation(checked, data) !== 'identical' || canonical(policies(checked)) !== canonical(policies(data))) throw new Error('Native V2 import would lose or change conversation data or policy.');
  }
  async transferFiles(data, temp, prefix, { local, sanitize = false } = {}) {
    const previous = new Map(v2Members(local).map(member => [member.info.id, member]));
    const files = [], planned = structuredClone(data);
    for (const member of v2Members(planned)) {
      if (sanitize) {
        delete member.info.permissions; delete member.info.share;
        const permission = previous.get(member.info.id)?.info.permissions;
        if (permission !== undefined) member.info.permissions = structuredClone(permission);
      }
      const { format, children, ...native } = member; void format; void children;
      const file = path.join(temp, `${prefix}-${member.info.id}.json`);
      await writeFile(file, JSON.stringify(native), { mode: 0o600 }); files.push(file);
    }
    return { files, planned };
  }
  async importFiles(files, working, imported) {
    let output = '';
    for (const file of files) {
      const data = JSON.parse(await readFile(file, 'utf8'));
      const result = await this.command(['session', 'import', file], working);
      if (!result.includes(`Imported session: ${data.info.id}`)) throw new Error('V2 family member import was not confirmed.');
      imported?.(data.info.id);
      output += result;
    }
    return output;
  }
  async write(data, cwd, expectedHash, { backupDirectory } = {}) {
    validateV2Transfer(data);
    const working = await realpath(cwd);
    if (!(await stat(working)).isDirectory()) throw new Error('Relink this V2 conversation to an existing folder.');
    const local = await this.read(data.info.id);
    if (v2Hash(local) !== expectedHash) throw new Error('V2 conversation changed since preview.');
    const relation = v2Relation(local, data);
    if (relation === 'identical' || relation === 'local-newer') return;
    if (relation === 'conflict') throw new Error('V2 import cannot overwrite divergent history. Keep the local chat; no conversation was deleted.');
    await this.inspect(data, local);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-import-'));
    let lock, lockFile, recoveryBlocked = false;
    try {
      lockFile = `${await this.databasePath()}.${data.info.id}.mik-import.lock`;
      await mkdir(path.dirname(lockFile), { recursive: true });
      try { lock = await open(lockFile, 'wx', 0o600); }
      catch { throw new Error('Another V2 replacement is in progress or needs recovery. No conversation was deleted.'); }
      const { files, planned } = await this.transferFiles(data, temp, 'incoming', { local, sanitize: true });
      await this.validateImport(files, planned, working, temp, 'incoming');
      if (local) {
        const originalFolder = await realpath(local.info.location.directory);
        const { files: restore } = await this.transferFiles(local, temp, 'original');
        await this.validateImport(restore, local, originalFolder, temp, 'rollback');
        const backups = backupDirectory || path.join(this.repo, '.mrmak', 'import-backups', 'opencode-v2');
        await mkdir(backups, { recursive: true });
        const backup = path.join(backups, `${data.info.id}-${randomUUID()}.json`);
        const handle = await open(backup, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(local)); await handle.sync(); } finally { await handle.close(); }
        if (canonical(JSON.parse(await readFile(backup, 'utf8'))) !== canonical(local)) throw new Error('V2 recovery backup could not be verified. No conversation was deleted.');
        if (canonical(await this.read(data.info.id)) !== canonical(local)) throw new Error('V2 conversation changed during validation. Preview again.');
        let removed = false;
        try {
          await this.command(['session', 'delete', data.info.id]);
          if (await this.read(data.info.id)) throw new Error('V2 deletion was not confirmed.');
          removed = true;
          const output = await this.importFiles(files, working);
          if (!output.includes(`Imported session: ${data.info.id}`)) throw new Error('V2 continuation import was not confirmed.');
          const result = await this.read(data.info.id);
          if (!result || v2Relation(result, data) !== 'identical' || path.resolve(result.info.location.directory).toLowerCase() !== working.toLowerCase() || canonical(policies(result)) !== canonical(policies(planned))) throw new Error('V2 continuation verification failed.');
          return { updated: true, backup };
        } catch {
          try {
            const current = await this.read(data.info.id, { allowIncomplete: true });
            if (current && canonical(current) === canonical(local) && !removed) throw new Error('original-retained');
            // Never delete an unrelated branch created by an external CLI.
            if (current && !exactSubset(current, planned)) throw new Error('foreign-change');
            if (current) await this.command(['session', 'delete', data.info.id]);
            if (await this.read(data.info.id)) throw new Error('rollback-delete');
            await this.importFiles(restore, originalFolder);
            const restored = await this.read(data.info.id);
            if (!restored || v2Relation(restored, local) !== 'identical' || path.resolve(restored.info.location.directory).toLowerCase() !== originalFolder.toLowerCase() || canonical(policies(restored)) !== canonical(policies(local))) throw new Error('rollback-verification');
          } catch (error) {
            if (error.message === 'original-retained') throw new Error(`V2 replacement failed before deletion; original retained. Recovery backup: ${backup}`);
            recoveryBlocked = true;
            throw new Error(`V2 replacement failed and automatic recovery could not be verified. Do not retry; recovery backup: ${backup}`);
          }
          throw new Error(`V2 replacement failed; the original conversation was restored. Recovery backup: ${backup}`);
        }
      }
      if (await this.read(data.info.id)) throw new Error('V2 ID appeared during validation. Preview again.');
      await this.inspect(data, null);
      const imported = new Set();
      try {
        await this.importFiles(files, working, id => imported.add(id));
        const result = await this.read(data.info.id);
        if (!result || path.resolve(result.info.location.directory).toLowerCase() !== working.toLowerCase() || v2Relation(result, data) !== 'identical' || canonical(policies(result)) !== canonical(policies(planned))) throw new Error('Native V2 import did not match the reviewed conversation.');
      } catch {
        try {
          const current = await this.read(data.info.id, { allowIncomplete: true });
          if (current) {
            if (!imported.has(data.info.id) || !exactSubset(current, planned)) throw new Error('Unconfirmed or foreign content');
            await this.command(['session', 'delete', data.info.id]);
          }
          for (const member of v2Members(data)) if (await this.inspectDb(member.info.id, (db, row) => !!row, { member: true })) throw new Error('Partial import remains');
        } catch {
          recoveryBlocked = true;
          throw new Error('V2 family import failed and partial-data cleanup could not be verified. History was not connected. Keep the source archive and request recovery assistance.');
        }
        throw new Error('V2 import failed; confirmed partial imports were removed. History was not connected.');
      }
    } finally {
      if (lock) { await lock.close(); if (!recoveryBlocked) await rm(lockFile, { force: true }); }
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  async remove(id, expectedHash) {
    const data = await this.read(id);
    if (!data || !expectedHash || v2Hash(data) !== expectedHash) throw new Error('V2 conversation changed. Review deletion again.');
    const lockFile = `${await this.databasePath()}.${id}.mik-import.lock`; let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch { throw new Error('V2 import/recovery lock is present. Resolve it before native deletion.'); }
    try {
      if (v2Hash(await this.read(id)) !== expectedHash) throw new Error('V2 family changed before deletion. Review again.');
      await this.command(['session', 'delete', id]);
      for (const member of v2Members(data)) if (await this.inspectDb(member.info.id, (db, row) => !!row, { member: true })) throw new Error('V2 native family deletion was not confirmed. History was retained.');
    } finally { await lock.close(); await rm(lockFile, { force: true }); }
  }
}
