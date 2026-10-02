import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, lstat } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { Zip, ZipDeflate, Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { codexTranscript, claudeTranscript } from './native-events.mjs';
import { readJson, saveJson, within } from './util.mjs';
import { makHistory, mergeMakHistory } from './mak-history.mjs';
import { makConversations, mergeMakConversations } from './mak-conversations.mjs';
import { workerEfforts, claudeEfforts } from './effort.mjs';
import { OpenCodeTransfer, validateOpenCode, parseOpenCode, openCodeHash, openCodeRelation, openCodeMembers, openCodeIdentities as transferIdentities } from './opencode-transfer.mjs';
import { reviewAttachments, embedAttachments } from './opencode-attachments.mjs';
import { validSessionId } from './opencode.mjs';

const included = ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.agents/skills', '.claude/skills'];
const uuid = /^[a-f0-9-]{36}$/i;
const safePath = value => typeof value === 'string' && value.length < 500 && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const safeArchivePath = name => {
  const skill = /^(?:\.agents|\.claude)\/skills\/(.+)$/.exec(name);
  return skill ? safePath(skill[1]) : safePath(name);
};
const privateName = value => /(^|\/)(?:\.env(?:\.|$)|auth|credentials?|tokens?|runtime|node_modules|target|cache)(?:[.\/-]|$)/i.test(value);
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const nativeKey = session => `${session.agent}:${session.nativeId || `history-${session.id}`}`;
const nativeIssue = (session, reason) => ({ key: nativeKey(session), agent: session.agent, id: session.nativeId || null, sessionId: session.id || null, name: String(session.name || session.nativeId || session.id || 'Unnamed chat').replace(/[\x00-\x1f]/g, ' ').slice(0, 160), reason });
const nativeSkippedFile = (name, skipped) => [...skipped].some(key => { const [agent, id] = key.split(':'); return name === `native/${agent}/${id}.${agent === 'opencode' ? 'json' : 'jsonl'}` || agent === 'claude' && name.startsWith(`native/claude/${id}/`); });
async function verifyJsonl(file) {
  let count = 0;
  const input = createReadStream(file), lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) { const row = JSON.parse(line.trim()); if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid transcript record'); count++; } }
  finally { lines.close(); input.destroy(); }
  if (!count) throw new Error('Empty transcript');
}
// Only a complete, byte-for-byte JSONL prefix proves a continuation. Dates and
// file size alone cannot distinguish a newer conversation from a divergent one.
async function transcriptRelation(local, incoming) {
  const [a, b] = await Promise.all([stat(local), stat(incoming)]);
  if (a.size === b.size) return 'conflict'; // Identical hashes are handled by the caller.
  const shorter = a.size < b.size ? local : incoming;
  const longer = a.size < b.size ? incoming : local;
  const size = Math.min(a.size, b.size);
  if (!size) return 'conflict';
  const left = await open(shorter, 'r'), right = await open(longer, 'r');
  try {
    const tail = Buffer.alloc(1);
    await left.read(tail, 0, 1, size - 1);
    if (tail[0] !== 10) return 'conflict';
    const x = Buffer.alloc(65536), y = Buffer.alloc(65536);
    for (let offset = 0; offset < size; offset += x.length) {
      const length = Math.min(x.length, size - offset);
      const [u, v] = await Promise.all([left.read(x, 0, length, offset), right.read(y, 0, length, offset)]);
      if (u.bytesRead !== length || v.bytesRead !== length || !x.subarray(0, length).equals(y.subarray(0, length))) return 'conflict';
    }
    const input = createReadStream(shorter);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try { const value = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) return 'conflict'; }
        catch { return 'conflict'; }
      }
    } finally { lines.close(); input.destroy(); }
    return a.size < b.size ? 'update' : 'local-newer';
  } finally { await left.close(); await right.close(); }
}
const accepted = name => safeArchivePath(name) && !privateName(name) && (included.some(folder => name.startsWith(`${folder}/`)) || /^state\/(?:sessions|settings|inbox|mak-history|mak-conversations|screen-[a-f0-9-]{36})\.json$/i.test(name) || /^native\/(?:codex|claude)\/[a-f0-9-]{36}\.jsonl$/i.test(name) || /^native\/opencode\/ses[a-zA-Z0-9_-]{1,160}\.json$/.test(name) || /^native\/claude\/[a-f0-9-]{36}\/.+/i.test(name));
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const claudeStateKinds = ['tasks', 'file-history', 'uploads', 'image-cache'];
async function claudeCompanionTarget(transcript, id, name) {
  const relative = name.slice(`native/claude/${id}/`.length);
  let target;
  if (relative.startsWith('_mrmak-state/')) {
    const [, kind, ...parts] = relative.split('/');
    if (!claudeStateKinds.includes(kind) || !parts.length) throw new Error('Invalid Claude companion state entry.');
    target = path.join(path.dirname(claudeRoot()), kind, id, ...parts);
  } else {
    target = path.join(path.dirname(transcript), id, ...relative.split('/'));
  }
  const root = path.dirname(claudeRoot());
  if (!within(root, target)) throw new Error('Claude companion data leaves its profile.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink() || info && current !== target && !info.isDirectory() || info && current === target && !info.isFile()) throw new Error('Claude companion data contains an unsafe link or file type.');
  }
  return target;
}
async function findClaudeNative(id) {
  const matches = [];
  for (const folder of await readdir(claudeRoot(), { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory()) continue;
    const file = path.join(claudeRoot(), folder.name, `${id}.jsonl`);
    if ((await stat(file).catch(() => null))?.isFile()) matches.push(file);
  }
  if (matches.length > 1) throw new Error('Multiple native Claude files share this conversation ID. Resolve the duplicate before transferring it.');
  return matches.length === 1 ? matches[0] : null;
}
async function claudeExportEntries(file, id) {
  const entries = [], sidecar = path.join(path.dirname(file), id);
  if (await stat(path.join(sidecar, '_mrmak-state')).catch(() => null)) throw new Error('Claude companion data uses a reserved transfer folder name.');
  if ((await stat(sidecar).catch(() => null))?.isDirectory() && within(await realpath(path.dirname(file)), await realpath(sidecar))) await walkNative(sidecar, `native/claude/${id}`, entries);
  const root = await realpath(path.dirname(claudeRoot()));
  for (const kind of claudeStateKinds) {
    const folder = path.join(root, kind, id), actual = await realpath(folder).catch(() => null);
    if (actual && within(root, actual) && actual === folder && (await stat(folder)).isDirectory()) await walkNative(folder, `native/claude/${id}/_mrmak-state/${kind}`, entries);
  }
  return entries;
}

async function walk(root, relative, found) {
  const folder = path.join(root, relative);
  for (const item of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const name = `${relative}/${item.name}`.replaceAll('\\', '/');
    if (item.isSymbolicLink() || !accepted(name)) continue;
    if (item.isDirectory()) await walk(root, name, found);
    else if (item.isFile()) found.push({ name, source: path.join(root, name) });
  }
}
async function walkNative(folder, prefix, found) {
  for (const item of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const name = `${prefix}/${item.name}`;
    if (item.isSymbolicLink() || !accepted(name)) continue;
    if (item.isDirectory()) await walkNative(path.join(folder, item.name), name, found);
    else if (item.isFile()) found.push({ name, source: path.join(folder, item.name) });
  }
}

async function writeZip(target, entries) {
  const stream = createWriteStream(target, { flags: 'wx' });
  let failure = null;
  const zip = new Zip((error, chunk, final) => {
    if (error) { failure = error; stream.destroy(error); return; }
    if (chunk?.length) stream.write(Buffer.from(chunk));
    if (final) stream.end();
  });
  stream.on('error', error => { failure = error; });
  try {
    for (const entry of entries) {
      if (failure) throw failure;
      const item = new ZipDeflate(entry.name, { level: 6 });
      zip.add(item);
      if (entry.data) item.push(Buffer.from(entry.data), true);
      else { for await (const chunk of createReadStream(entry.source, { highWaterMark: 64 * 1024 })) { if (failure) throw failure; item.push(chunk); } item.push(new Uint8Array(), true); }
    }
    zip.end();
    await once(stream, 'finish');
    if (failure) throw failure;
  } catch (error) { zip.terminate(); stream.destroy(); throw error; }
}

async function extractZip(archive, destination) {
  const extracted = new Map();
  const pending = [];
  let failure = null, count = 0, total = 0;
  const unzip = new Unzip(file => {
    const name = file.name;
    if (!safeArchivePath(name) || (!accepted(name) && name !== 'manifest.json')) { failure = new Error('Archive contains an unsafe or unexpected path.'); return; }
    if (++count > 20000 || extracted.has(name)) { failure = new Error('Archive has too many or duplicate entries.'); return; }
    const target = path.join(destination, ...name.split('/'));
    const task = (async () => {
      await mkdir(path.dirname(target), { recursive: true });
      const output = createWriteStream(target, { flags: 'wx' });
      file.ondata = (error, chunk, final) => {
        if (error) { failure = error; output.destroy(error); return; }
        total += chunk.length;
        if (total > 16 * 1024 ** 3) { failure = new Error('Archive is too large.'); output.destroy(failure); return; }
        if (chunk.length) output.write(Buffer.from(chunk));
        if (final) output.end();
      };
      file.start();
      await once(output, 'finish');
      extracted.set(name, target);
    })();
    pending.push(task);
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for await (const chunk of createReadStream(archive, { highWaterMark: 64 * 1024 })) { if (failure) break; unzip.push(chunk); }
  if (failure) throw failure;
  unzip.push(new Uint8Array(), true);
  await Promise.all(pending);
  if (!extracted.has('manifest.json')) throw new Error('Not a Mr. Mik workspace archive.');
  return extracted;
}

export class PortableArchive {
  constructor(repo, stateDir, sessions, projects) { Object.assign(this, { repo, stateDir, sessions, projects }); this.openCode = new OpenCodeTransfer(repo); this.attachmentPlans = new Map(); }

  async verifyNativeTranscripts(sessions = this.sessions.list(), mak, reportOnly = false) {
    mak ??= makConversations(await readJson(path.join(this.stateDir, 'mak-conversations.json'), { conversations: [], selected: {} }));
    const missing = [], checked = new Set();
    for (const session of [...sessions, ...mak.conversations.filter(item => item.threadId).map(item => ({ agent: 'codex', nativeId: item.threadId, name: `Mik · ${item.title || item.id}`, purpose: 'mak' }))]) {
      if (!['codex', 'claude'].includes(session.agent)) continue;
      // An explicit empty tab is not a missing conversation. Older metadata can
      // have a false flag even with user activity; never skip that activity.
      if (session.hasConversation === false && !session.lastInputAt && !session.preview && !session.purpose) continue;
      if (!session.nativeId && !session.hasConversation && !session.lastInputAt && !session.preview) continue;
      const key = `${session.agent}:${session.nativeId || session.id}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (!uuid.test(session.nativeId || '')) { missing.push(nativeIssue(session, 'Native ID missing')); continue; }
      try {
        const file = session.agent === 'codex' ? await codexTranscript(session.nativeId, { strict: true }) : await claudeTranscript(session.cwd, session.nativeId, { search: true });
        if (!file || !(await stat(file)).isFile()) throw new Error('Missing transcript');
        const handle = await open(file, 'r'); await handle.close();
        await verifyJsonl(file);
        if (session.agent === 'claude') for (const entry of await claudeExportEntries(file, session.nativeId)) {
          if (entry.name.endsWith('.jsonl')) await verifyJsonl(entry.source);
          else { const handle = await open(entry.source, 'r'); await handle.close(); }
        }
      } catch { missing.push(nativeIssue(session, 'Transcript/companion data missing, ambiguous, invalid or unreadable')); }
    }
    if (missing.length && !reportOnly) throw new Error(`Full export blocked: ${missing.length} native chat(s) cannot be transferred. ${missing.map(item => `${item.name} (${item.reason.toLowerCase()})`).join('; ')}. Review export and explicitly skip these conversations, recover them or choose light export (History/screens only). No incomplete archive was created.`);
    return missing;
  }

  async reviewExport(folder) {
    const destination = await realpath(folder);
    if (!(await stat(destination)).isDirectory() || within(this.repo, destination)) throw new Error('Choose an export folder outside the hub.');
    if (this.sessions.list().some(item => item.open)) throw new Error('Close all chat tabs before exporting.');
    const issues = await this.verifyNativeTranscripts(undefined, undefined, true);
    const families = [], hashes = {}, reviewedOpenCode = new Set();
    for (const session of this.sessions.list().filter(item => item.agent === 'opencode' && (item.nativeId || item.hasConversation))) {
      if (reviewedOpenCode.has(nativeKey(session))) continue;
      reviewedOpenCode.add(nativeKey(session));
      if (!validSessionId(session.nativeId)) { issues.push(nativeIssue(session, 'Native ID missing')); continue; }
      if (session.nativeId in hashes) continue;
      let data;
      try {
        data = await this.openCode.read(session.nativeId);
        if (!data) throw new Error('Missing conversation');
        validateOpenCode(data, session.nativeId, { portable: false });
        await reviewAttachments([data]);
      } catch { issues.push(nativeIssue(session, 'OpenCode conversation/family or attachments cannot be transferred safely')); continue; }
      families.push(data); hashes[session.nativeId] = openCodeHash(data);
    }
    const files = await reviewAttachments(families), token = randomUUID();
    for (const [key, plan] of this.attachmentPlans) if (plan.expires < Date.now()) this.attachmentPlans.delete(key);
    if (this.attachmentPlans.size >= 16) this.attachmentPlans.clear();
    this.attachmentPlans.set(token, { destination, files, hashes, issues, history: JSON.stringify(this.sessions.list()), expires: Date.now() + 5 * 60000 });
    return { token, issues, files: files.map(({ path, bytes }) => ({ path, bytes })) };
  }

  async exportTo(folder, { chats = 'full', attachmentToken, approveAttachments = false, skipNative = [] } = {}) {
    if (!['full', 'light'].includes(chats)) throw new Error('Choose full or light chat export.');
    const destination = await realpath(folder);
    const plan = attachmentToken ? this.attachmentPlans.get(attachmentToken) : null;
    if (attachmentToken) {
      this.attachmentPlans.delete(attachmentToken);
      if (!plan || plan.expires < Date.now() || plan.destination !== destination || plan.history !== JSON.stringify(this.sessions.list()) || (plan.files.length && approveAttachments !== true)) throw new Error('Attachment review expired, changed or was not confirmed. Review export again.');
    }
    if (!Array.isArray(skipNative) || new Set(skipNative).size !== skipNative.length || skipNative.some(key => !plan?.issues.some(issue => issue.key === key)) || plan?.issues.some(issue => !skipNative.includes(issue.key))) throw new Error('Review and explicitly confirm every unavailable conversation before full export. Healthy chats cannot be excluded through this confirmation.');
    if (skipNative.length && chats !== 'full') throw new Error('Native exclusions require a reviewed full export.');
    const skipped = new Set(skipNative);
    if (!(await stat(destination)).isDirectory() || within(this.repo, destination)) throw new Error('Choose an export folder outside the hub.');
    if (this.sessions.list().some(item => item.open)) throw new Error('Close all chat tabs before exporting a consistent workspace snapshot.');
    const entries = [];
    for (const relative of included) await walk(this.repo, relative, entries);
    const sessions = this.sessions.list().map(({ toolRefresh, ...saved }) => { void toolRefresh; return saved; });
    const settings = await readJson(path.join(this.stateDir, 'settings.json'), {});
    const portableSettings = Object.fromEntries(['defaultAgent', 'defaultBypass', 'defaultWorkerEffort', 'defaultClaudeWorkerEffort', 'terminalFontSize', 'terminalAppearance', 'accentTheme', 'coordinatorEffort', 'voiceName', 'selectedProjectId'].filter(key => key in settings).map(key => [key, settings[key]]));
    const stateFiles = { 'state/sessions.json': sessions, 'state/settings.json': portableSettings, 'state/inbox.json': await readJson(path.join(this.stateDir, 'inbox.json'), { resources: [] }) };
    stateFiles['state/mak-history.json'] = makHistory(await readJson(path.join(this.stateDir, 'mak-history.json'), { operations: [] }));
    const mak = makConversations(await readJson(path.join(this.stateDir, 'mak-conversations.json'), { conversations: [], selected: {} }));
    if (chats === 'full') {
      const missing = await this.verifyNativeTranscripts(sessions, mak, true);
      if (missing.some(issue => !skipped.has(issue.key))) await this.verifyNativeTranscripts(sessions, mak);
      if (plan && JSON.stringify(missing) !== JSON.stringify(plan.issues.filter(issue => issue.agent !== 'opencode'))) throw new Error('Native availability changed after review. Review export again.');
      for (const issue of (plan?.issues || []).filter(issue => issue.agent === 'opencode' && validSessionId(issue.id))) {
        let unavailable = false;
        try { const data = await this.openCode.read(issue.id); if (!data) throw new Error(); validateOpenCode(data, issue.id, { portable: false }); await reviewAttachments([data]); }
        catch { unavailable = true; }
        if (!unavailable) throw new Error('OpenCode availability changed after review. Review export again rather than excluding a recovered conversation.');
      }
    }
    for (const session of sessions) {
      const issue = plan?.issues.find(item => item.key === nativeKey(session));
      if (issue) session.nativeUnavailable = issue.reason;
    }
    for (const conversation of mak.conversations) {
      const issue = plan?.issues.find(item => item.key === `codex:${conversation.threadId}`);
      if (issue) conversation.nativeUnavailable = issue.reason;
    }
    stateFiles['state/sessions.json'] = sessions;
    stateFiles['state/mak-conversations.json'] = mak;
    for (const [name, value] of Object.entries(stateFiles)) entries.push({ name, data: JSON.stringify(value) });
    for (const session of sessions) {
      const file = path.join(this.stateDir, `screen-${session.id}.json`);
      if (await stat(file).catch(() => null)) entries.push({ name: `state/screen-${session.id}.json`, source: file });
    }
    const locations = await readJson(path.join(this.stateDir, 'project-locations.json'), {});
    const native = [];
    const openCodeExportIds = new Set();
    if (chats === 'full') for (const session of [...sessions, ...mak.conversations.filter(item => item.threadId).map(item => ({ agent: 'codex', nativeId: item.threadId, cwd: this.repo, purpose: 'mak' }))]) {
      if (skipped.has(nativeKey(session))) continue;
      if (session.agent === 'opencode') {
        if (!session.nativeId && !session.hasConversation) continue;
        if (!validSessionId(session.nativeId)) throw new Error('This OpenCode conversation has no verified native ID. Recover it before full export, or choose light export.');
        if (native.some(item => item.agent === 'opencode' && item.id === session.nativeId)) continue;
        let data = await this.openCode.read(session.nativeId);
        if (!data) throw new Error('An OpenCode conversation is missing. Full export cannot silently omit it; use light export.');
        if (plan) {
          if (plan.hashes[session.nativeId] !== openCodeHash(data)) throw new Error('OpenCode conversation changed after attachment review. Review export again.');
        }
        data = await embedAttachments(data, plan?.files || []);
        validateOpenCode(data, session.nativeId);
        for (const member of openCodeMembers(data)) for (const identity of transferIdentities(member)) {
          if (openCodeExportIds.has(identity)) throw new Error('OpenCode families overlap or changed during export. Close their CLIs and retry.');
          openCodeExportIds.add(identity);
        }
        const familyIds = new Set(openCodeMembers(data).map(member => member.info.id));
        if (sessions.some(other => other.agent === 'opencode' && other.nativeId !== session.nativeId && familyIds.has(other.nativeId))) throw new Error('An OpenCode child session has a separate History association. Remove that association before full family export.');
        for (const member of openCodeMembers(data)) { delete member.info.permission; delete member.info.permissions; delete member.info.share; delete member.info.workspaceID; }
        const name = `native/opencode/${session.nativeId}.json`, content = JSON.stringify(data);
        entries.push({ name, data: content });
        native.push({ agent: 'opencode', id: session.nativeId, name, nativeFormat: data.format || 'opencode-v1', sha256: createHash('sha256').update(content).digest('hex'), cwd: session.cwd });
        continue;
      }
      if (session.hasConversation === false && !session.lastInputAt && !session.preview && !session.purpose) continue;
      if (!uuid.test(session.nativeId || '') || !['codex', 'claude'].includes(session.agent)) continue;
      if (native.some(item => item.agent === session.agent && item.id === session.nativeId)) continue;
      const file = session.agent === 'codex' ? await codexTranscript(session.nativeId, { strict: true }) : await claudeTranscript(session.cwd, session.nativeId, { search: true });
      if (!file || !(await stat(file).catch(() => null))?.isFile()) throw new Error('Native transcript disappeared during full export. No incomplete archive was created; retry or choose light export.');
      const name = `native/${session.agent}/${session.nativeId}.jsonl`;
      entries.push({ name, source: file });
      if (session.agent === 'claude') {
        entries.push(...await claudeExportEntries(file, session.nativeId));
      }
      const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      native.push({ agent: session.agent, id: session.nativeId, ...(session.purpose ? { purpose: session.purpose } : {}), name, sha256: await digest(file), cwd: session.cwd,
        relative: session.agent === 'codex' ? path.relative(path.join(codexRoot, 'sessions'), file).replaceAll('\\', '/') : null });
    }
    const projectPaths = Object.fromEntries(Object.entries(locations).map(([id, item]) => [id, item.repositories || { primary: item.repositoryPath }]));
    const projectRegistry = await readJson(path.join(this.repo, 'projects', 'registry.json'), { projects: [] });
    const projectNames = Object.fromEntries((projectRegistry.projects || []).map(item => [item.id, item.name]));
    const projectDefinitions = Object.fromEntries((projectRegistry.projects || []).map(item => [item.id, { name: item.name, repositories: item.repositories }]));
    const manifest = { format: 'mrmak-workspace', version: 1, createdAt: new Date().toISOString(), chats, sourceHub: this.repo, projectPaths, projectNames, projectDefinitions, native, nativeOmissions: plan?.issues || [], files: [] };
    for (const entry of entries) {
      if (!accepted(entry.name) && !entry.name.startsWith('native/')) throw new Error('Unexpected export entry.');
      manifest.files.push({ name: entry.name, size: entry.source ? (await stat(entry.source)).size : Buffer.byteLength(entry.data), sha256: entry.source ? await digest(entry.source) : createHash('sha256').update(entry.data).digest('hex') });
    }
    const name = `MrMak-Workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.mrmak.zip`;
    const target = path.join(destination, name);
    await writeZip(target, [{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...entries]);
    return { path: target, files: entries.length, chats: native.length, omitted: skipped.size, bytes: (await stat(target)).size };
  }

  async preview(source) {
    const archive = await realpath(source);
    if (!(await stat(archive)).isFile() || !archive.toLowerCase().endsWith('.mrmak.zip')) throw new Error('Choose a Mr. Mik workspace archive.');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mrmak-import-'));
    try {
      const reviewHash = await digest(archive);
      const extracted = await extractZip(archive, temp);
      const manifest = JSON.parse(await readFile(extracted.get('manifest.json'), 'utf8'));
      if (extracted.has('state/mak-history.json')) makHistory(JSON.parse(await readFile(extracted.get('state/mak-history.json'), 'utf8')));
      const mak = extracted.has('state/mak-conversations.json') ? makConversations(JSON.parse(await readFile(extracted.get('state/mak-conversations.json'), 'utf8'))) : { conversations: [], selected: {} };
      mergeMakConversations(await readJson(path.join(this.stateDir, 'mak-conversations.json'), { conversations: [], selected: {} }), mak);
      if (manifest.format !== 'mrmak-workspace' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.native)) throw new Error('Unsupported workspace archive.');
      if (new Set(manifest.files.map(file => file.name)).size !== manifest.files.length || manifest.files.some(file => !accepted(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256))) throw new Error('Archive file inventory is invalid or unsafe.');
      if ([...extracted.keys()].some(name => name !== 'manifest.json' && !manifest.files.some(file => file.name === name))) throw new Error('Archive file inventory does not match its manifest.');
      const missingFiles = new Set();
      for (const file of manifest.files) {
        const actual = extracted.get(file.name);
        if (!actual && manifest.native.some(item => file.name === item.name || item.agent === 'claude' && file.name.startsWith(`native/claude/${item.id}/`))) { missingFiles.add(file.name); continue; }
        if (!actual || (await stat(actual)).size !== file.size || await digest(actual) !== file.sha256) throw new Error('Archive integrity check failed.');
      }
      const jsonArray = async (name, field) => {
        const file = extracted.get(name);
        if (!file) throw new Error(`Archive is missing ${name}.`);
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (field ? !value || !Array.isArray(value[field]) : !Array.isArray(value)) throw new Error(`Archive contains invalid ${name}.`);
        return field ? value[field] : value;
      };
      const sessions = await jsonArray('state/sessions.json');
      await jsonArray('projects/registry.json', 'projects');
      await jsonArray('workspace/workspace.json', 'entities');
      await jsonArray('state/inbox.json', 'resources');
      for (const session of sessions) if (!session || !uuid.test(session.id) || !['codex', 'claude', 'opencode', 'kimi', 'shell'].includes(session.agent) || session.nativeUnavailable != null && (typeof session.nativeUnavailable !== 'string' || session.nativeUnavailable.length > 200)) throw new Error('Archive contains invalid chat metadata.');
      if (!manifest.projectPaths || typeof manifest.projectPaths !== 'object' || Array.isArray(manifest.projectPaths)) throw new Error('Archive has no project location map.');
      for (const [projectId, repositories] of Object.entries(manifest.projectPaths)) {
        if (!uuid.test(projectId) || !repositories || typeof repositories !== 'object' || Array.isArray(repositories)) throw new Error('Archive contains invalid project locations.');
        for (const [repositoryId, location] of Object.entries(repositories)) if (!/^[\w-]{1,100}$/.test(repositoryId) || ['__proto__', 'constructor', 'prototype'].includes(repositoryId) || typeof location !== 'string') throw new Error('Archive contains invalid repository locations.');
      }
      const native = [];
      const openCodeIdentities = new Set();
      if (new Set(manifest.native.map(item => `${item.agent}:${item.id}`)).size !== manifest.native.length) throw new Error('Archive contains duplicate native conversation entries.');
      for (const item of manifest.native) {
        // Identity, ownership and checksums are archive-wide trust boundaries.
        if (!['codex', 'claude', 'opencode'].includes(item.agent) || !(item.agent === 'opencode' ? validSessionId(item.id) : uuid.test(item.id || '')) || item.name !== `native/${item.agent}/${item.id}.${item.agent === 'opencode' ? 'json' : 'jsonl'}` || manifest.files.find(file => file.name === item.name)?.sha256 !== item.sha256) throw new Error('Invalid native entry or checksum declaration.');
        if (item.purpose === 'mak' ? item.agent !== 'codex' || !mak.conversations.some(conversation => conversation.threadId === item.id) : !sessions.some(session => session.agent === item.agent && session.nativeId === item.id)) throw new Error('Native transcript has no matching conversation in History.');
        if (item.agent === 'codex' && (!safePath(item.relative) || !item.relative.endsWith(`-${item.id}.jsonl`))) throw new Error('Invalid Codex transcript location.');
        try {
          if (missingFiles.has(item.name) || item.agent === 'claude' && [...missingFiles].some(name => name.startsWith(`native/claude/${item.id}/`))) throw new Error('Missing native conversation data');
          if (item.agent === 'opencode') {
            if (!validSessionId(item.id) || item.name !== `native/opencode/${item.id}.json` || !sessions.some(session => session.agent === 'opencode' && session.nativeId === item.id) || manifest.files.find(file => file.name === item.name)?.sha256 !== item.sha256) throw new Error('Invalid native OpenCode entry or History association.');
            if ((await stat(extracted.get(item.name))).size > 64 * 1024 ** 2) throw new Error('OpenCode session export exceeds the supported 64 MB limit.');
            const incoming = validateOpenCode(parseOpenCode(await readFile(extracted.get(item.name), 'utf8')), item.id);
            if (item.nativeFormat && item.nativeFormat !== (incoming.format || 'opencode-v1')) throw new Error('OpenCode native archive format does not match its manifest.');
            for (const member of openCodeMembers(incoming)) {
              for (const identity of transferIdentities(member)) {
                if (openCodeIdentities.has(identity)) throw Object.assign(new Error('Archive contains overlapping OpenCode families or message identities.'), { archiveFatal: true });
                openCodeIdentities.add(identity);
              }
            }
            const childIds = new Set(openCodeMembers(incoming).slice(1).map(member => member.info.id));
            if ([...sessions, ...this.sessions.list()].some(session => session.agent === 'opencode' && childIds.has(session.nativeId))) throw Object.assign(new Error('An OpenCode child session has a separate History association. Remove that association before family import.'), { archiveFatal: true });
            const local = await this.openCode.read(item.id);
            await this.openCode.inspect?.(incoming, local);
            native.push({ agent: 'opencode', id: item.id, cwd: item.cwd, name: sessions.find(session => session.agent === 'opencode' && session.nativeId === item.id)?.name, status: openCodeRelation(local, incoming), localHash: openCodeHash(local), familySize: openCodeMembers(incoming).length, local: null, sidecars: [] });
            continue;
          }
          if (!['codex', 'claude'].includes(item.agent) || !uuid.test(item.id) || item.name !== `native/${item.agent}/${item.id}.jsonl`) throw new Error('Invalid native session entry.');
          if (item.purpose === 'mak' ? item.agent !== 'codex' || !mak.conversations.some(conversation => conversation.threadId === item.id) : !sessions.some(session => session.agent === item.agent && session.nativeId === item.id)) throw new Error('Native transcript has no matching conversation in History.');
          if (item.agent === 'codex' && (!safePath(item.relative) || !item.relative.endsWith(`-${item.id}.jsonl`))) throw new Error('Invalid Codex transcript location.');
          if (manifest.files.find(file => file.name === item.name)?.sha256 !== item.sha256) throw new Error('Native session checksum does not match the archive.');
          await verifyJsonl(extracted.get(item.name));
          const local = item.agent === 'codex' ? await codexTranscript(item.id, { strict: true }) : await findClaudeNative(item.id);
          const localHash = local && await stat(local).catch(() => null) ? await digest(local) : null;
          let status = !localHash ? 'new' : localHash === item.sha256 ? 'identical' : await transcriptRelation(local, extracted.get(item.name));
          // Claude subagent logs are part of the same conversation. A changed
          // existing sidecar also requires explicit replacement, not silent loss.
          const sidecars = [];
          if (item.agent === 'claude') {
            for (const entry of manifest.files.filter(file => file.name.startsWith(`native/claude/${item.id}/`))) {
              if (entry.name.endsWith('.jsonl')) await verifyJsonl(extracted.get(entry.name));
              const transcript = local || await claudeTranscript(item.cwd, item.id);
              const target = await claudeCompanionTarget(transcript, item.id, entry.name);
              const hash = await stat(target).catch(() => null) ? await digest(target) : null;
              sidecars.push({ name: entry.name, localHash: hash });
              if (['new', 'update', 'identical'].includes(status) && hash && hash !== entry.sha256 && (!entry.name.endsWith('.jsonl') || await transcriptRelation(target, extracted.get(entry.name)) !== 'update')) status = 'conflict';
            }
          }
          native.push({ agent: item.agent, id: item.id, cwd: item.cwd, name: item.purpose === 'mak' ? `Mak · ${mak.conversations.find(conversation => conversation.threadId === item.id)?.title}` : sessions.find(session => session.agent === item.agent && session.nativeId === item.id)?.name, status, localHash, local, sidecars });
        } catch (error) {
          if (error.archiveFatal) throw error;
          const session = sessions.find(session => session.agent === item.agent && session.nativeId === item.id) || { agent: item.agent, nativeId: item.id, name: `Mik · ${mak.conversations.find(conversation => conversation.threadId === item.id)?.title || item.id}` };
          native.push({ ...nativeIssue(session, 'Native conversation/family is missing, invalid or not safely importable'), status: 'unavailable', localHash: null, local: null, sidecars: [] });
        }
      }
      if (manifest.nativeOmissions != null && (!Array.isArray(manifest.nativeOmissions) || manifest.nativeOmissions.length > 10000)) throw new Error('Invalid omitted conversation inventory.');
      for (const issue of manifest.nativeOmissions || []) {
        const session = sessions.find(session => nativeKey(session) === issue.key) || mak.conversations.filter(item => item.threadId).map(item => ({ agent: 'codex', nativeId: item.threadId, name: `Mik · ${item.title}` })).find(session => nativeKey(session) === issue.key);
        if (!session || !['codex', 'claude', 'opencode'].includes(session.agent) || typeof issue.reason !== 'string' || issue.reason.length > 200 || manifest.native.some(item => `${item.agent}:${item.id}` === issue.key)) throw new Error('Invalid omitted conversation association.');
        if (!native.some(item => (item.key || `${item.agent}:${item.id}`) === issue.key)) native.push({ ...nativeIssue(session, issue.reason), status: 'unavailable', localHash: null, local: null, sidecars: [] });
      }
      if (manifest.chats === 'full') for (const session of [...sessions, ...mak.conversations.filter(item => item.threadId).map(item => ({ agent: 'codex', nativeId: item.threadId, name: `Mik · ${item.title}` }))]) {
        if (!['codex', 'claude', 'opencode'].includes(session.agent) || !session.nativeId && !session.hasConversation && !session.lastInputAt && !session.preview || session.hasConversation === false && !session.lastInputAt && !session.preview) continue;
        if (!native.some(item => (item.key || `${item.agent}:${item.id}`) === nativeKey(session))) native.push({ ...nativeIssue(session, 'No native conversation included in this full archive'), status: 'unavailable', localHash: null, local: null, sidecars: [] });
      }
      const hubConflicts = [];
      for (const file of manifest.files.filter(item => !item.name.startsWith('native/') && !/^state\/(?:sessions|mak-history|mak-conversations|screen-.*)\.json$/.test(item.name))) {
        const target = file.name.startsWith('state/') ? path.join(this.stateDir, file.name.slice(6)) : path.join(this.repo, ...file.name.split('/'));
        if (await stat(target).catch(() => null)) hubConflicts.push({ name: file.name, identical: await digest(target) === file.sha256 });
      }
      const localLocations = await readJson(path.join(this.stateDir, 'project-locations.json'), {});
      const suggestedRelinks = Object.fromEntries(Object.entries(manifest.projectPaths).map(([id, repositories]) => [id, Object.fromEntries(Object.entries(repositories).map(([key, value]) => [key, localLocations[id]?.repositories?.[key] || (key === 'primary' && localLocations[id]?.repositoryPath) || value]))]));
      if (await digest(archive) !== reviewHash) throw new Error('Archive changed during review. Choose it again.');
      return { manifest, native, hubConflicts, suggestedRelinks, reviewHash };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  async importFrom(source, { relinks = {}, replaceNative = [], replaceHub = [], restoreSettings = false, skipNative = [], reviewHash } = {}) {
    if (this.sessions.list().some(item => item.open)) throw new Error('Close all chat tabs before importing.');
    const preview = await this.preview(source);
    const { manifest } = preview;
    const unavailable = preview.native.filter(item => item.status === 'unavailable');
    if (!Array.isArray(skipNative) || new Set(skipNative).size !== skipNative.length || skipNative.some(key => !unavailable.some(item => item.key === key)) || unavailable.some(item => !skipNative.includes(item.key))) throw new Error('Review and explicitly confirm skipping unavailable conversations before import.');
    if (unavailable.length && reviewHash !== preview.reviewHash || reviewHash && reviewHash !== preview.reviewHash) throw new Error('Import review expired or archive changed. Review it again before skipping conversations.');
    const skippedNative = new Set(skipNative);
    const allowedNative = new Set(replaceNative);
    const allowedHub = new Set(replaceHub);
    if ([...allowedNative].some(key => key.startsWith('opencode:'))) throw new Error('OpenCode conflicts cannot be overwritten by native import. Keep the local conversation.');
    for (const key of allowedNative) if (!preview.native.some(item => `${item.agent}:${item.id}` === key && item.status === 'conflict')) throw new Error('Unknown native replacement choice.');
    for (const key of allowedHub) if (!preview.hubConflicts.some(item => item.name === key && !item.identical)) throw new Error('Unknown hub replacement choice.');
    const mapped = {};
    const localRegistry = await readJson(path.join(this.repo, 'projects', 'registry.json'), { projects: [] });
    const localLocations = await readJson(path.join(this.stateDir, 'project-locations.json'), {});
    for (const [projectId, repositories] of Object.entries(manifest.projectPaths || {})) {
      if (!uuid.test(projectId)) throw new Error('Archive contains an invalid project ID.');
      const localProject = localRegistry.projects?.find(item => item.id === projectId);
      const importedProject = manifest.projectDefinitions?.[projectId];
      if (localProject && (localProject.name !== importedProject?.name || JSON.stringify(localProject.repositories) !== JSON.stringify(importedProject.repositories))) throw new Error('A project ID already exists with different metadata. Import into a fresh Hub or resolve the collision first.');
      mapped[projectId] = {};
      for (const [repositoryId, previous] of Object.entries(repositories || {})) {
        const proposed = relinks?.[projectId]?.[repositoryId] || localProject && (localLocations[projectId]?.repositories?.[repositoryId] || (repositoryId === 'primary' && localLocations[projectId]?.repositoryPath)) || previous;
        if (typeof proposed !== 'string' || !path.isAbsolute(proposed) || !(await stat(proposed).catch(() => null))?.isDirectory()) throw new Error('Relink every project repository to an existing folder before importing.');
        const root = await realpath(proposed);
        if (within(root, this.repo) || within(this.repo, root)) throw new Error('A linked project cannot be inside the Hub.');
        mapped[projectId][repositoryId] = root;
      }
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mrmak-import-'));
    const backup = path.join(this.stateDir, 'import-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    const result = { imported: 0, skipped: 0, nativeImported: 0, nativeUpdated: 0, nativeSkipped: unavailable.filter(item => !manifest.native.some(entry => `${entry.agent}:${entry.id}` === item.key)).length, sessionsUpdated: 0, backup };
    try {
      const extracted = await extractZip(await realpath(source), temp);
      const importedSessions = JSON.parse(await readFile(extracted.get('state/sessions.json'), 'utf8'));
      if (!Array.isArray(importedSessions)) throw new Error('Archive History is invalid.');
      const currentSessions = this.sessions.list();
      if (await digest(await realpath(source)) !== preview.reviewHash) throw new Error('Archive changed during import. Choose the archive again.');
      for (const entry of manifest.files) {
        if (!extracted.has(entry.name) && nativeSkippedFile(entry.name, skippedNative)) continue;
        if (await digest(extracted.get(entry.name)) !== entry.sha256) throw new Error('Archive changed during import. Choose the archive again.');
      }
      for (const session of importedSessions) {
        const existing = currentSessions.find(item => item.id === session.id);
        if (existing && (existing.agent !== session.agent || existing.nativeId !== session.nativeId)) throw new Error('A History ID belongs to a different conversation. Import into a fresh Hub.');
      }
      for (const item of preview.native) {
        if (item.status === 'unavailable') continue;
        if (item.agent === 'opencode') { if (openCodeHash(await this.openCode.read(item.id)) !== item.localHash) throw new Error('OpenCode conversation changed during import. Close its CLI and preview again.'); continue; }
        const local = item.agent === 'codex' ? await codexTranscript(item.id, { strict: true }) : await findClaudeNative(item.id);
        if ((local ? await digest(local) : null) !== item.localHash) throw new Error('A native conversation changed during import. Close its CLI and preview again.');
        for (const entry of item.sidecars) {
          const file = await claudeCompanionTarget(local || await claudeTranscript(item.cwd, item.id), item.id, entry.name);
          const hash = await stat(file).catch(() => null) ? await digest(file) : null;
          if (hash !== entry.localHash) throw new Error('Claude companion data changed during import. Close its CLI and preview again.');
        }
        // Claude resumes by the verified absolute transcript path. An existing
        // native file need not move or be duplicated when a linked folder changes.
      }
      const mergeById = (oldData, newData, field, preferIncoming = false) => {
        const output = structuredClone(oldData);
        output[field] ||= [];
        const positions = new Map(output[field].map((item, index) => [item.id, index]));
        for (const item of newData[field] || []) {
          if (positions.has(item.id)) { if (preferIncoming) output[field][positions.get(item.id)] = item; }
          else { positions.set(item.id, output[field].length); output[field].push(item); }
        }
        return output;
      };
      const incomingMak = extracted.has('state/mak-history.json') ? makHistory(JSON.parse(await readFile(extracted.get('state/mak-history.json'), 'utf8'))) : null;
      const special = new Set(['projects/registry.json', 'workspace/workspace.json', 'state/sessions.json', 'state/settings.json', 'state/inbox.json', 'state/mak-history.json', 'state/mak-conversations.json']);
      for (const entry of manifest.files.filter(item => !item.name.startsWith('native/') && !special.has(item.name) && !/^state\/screen-/.test(item.name))) {
        const target = entry.name.startsWith('state/') ? path.join(this.stateDir, entry.name.slice(6)) : path.join(this.repo, ...entry.name.split('/'));
        const current = await stat(target).catch(() => null);
        if (current && await digest(target) === entry.sha256) { result.skipped++; continue; }
        if (current && !allowedHub.has(entry.name)) { result.skipped++; continue; }
        await mkdir(path.dirname(target), { recursive: true });
        if (current) { await mkdir(path.dirname(path.join(backup, entry.name)), { recursive: true }); await copyFile(target, path.join(backup, entry.name)); }
        const staged = `${target}.${randomUUID()}.tmp`;
        await copyFile(extracted.get(entry.name), staged); await rename(staged, target); result.imported++;
      }
      for (const [name, field, fallback] of [['projects/registry.json', 'projects', { projects: [] }], ['workspace/workspace.json', 'entities', { entities: [], resources: [] }], ['state/inbox.json', 'resources', { resources: [] }]]) {
        if (!extracted.has(name)) continue;
        const target = name.startsWith('state/') ? path.join(this.stateDir, name.slice(6)) : path.join(this.repo, name);
        const original = await readJson(target, fallback), incoming = JSON.parse(await readFile(extracted.get(name), 'utf8'));
        const preferIncoming = allowedHub.has(name);
        if (preferIncoming && await stat(target).catch(() => null)) { const saved = path.join(backup, name); await mkdir(path.dirname(saved), { recursive: true }); await copyFile(target, saved); }
        let merged = mergeById(original, incoming, field, preferIncoming);
        if (name === 'workspace/workspace.json') merged = mergeById(merged, incoming, 'resources', preferIncoming);
        await saveJson(target, merged);
      }
      if (restoreSettings) {
        const file = extracted.get('state/settings.json');
        if (!file) throw new Error('Archive has no portable settings.');
        const incoming = JSON.parse(await readFile(file, 'utf8'));
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Archive settings are invalid.');
        const portable = {};
        if (['codex', 'claude', 'opencode', 'kimi', 'shell'].includes(incoming.defaultAgent)) portable.defaultAgent = incoming.defaultAgent;
        if (typeof incoming.defaultBypass === 'boolean') portable.defaultBypass = incoming.defaultBypass;
        if (workerEfforts.includes(incoming.defaultWorkerEffort)) portable.defaultWorkerEffort = incoming.defaultWorkerEffort;
        if (claudeEfforts.includes(incoming.defaultClaudeWorkerEffort)) portable.defaultClaudeWorkerEffort = incoming.defaultClaudeWorkerEffort;
        if (Number.isInteger(incoming.terminalFontSize) && incoming.terminalFontSize >= 10 && incoming.terminalFontSize <= 24) portable.terminalFontSize = incoming.terminalFontSize;
        if (['focus', 'original'].includes(incoming.terminalAppearance)) portable.terminalAppearance = incoming.terminalAppearance;
        if (['rose', 'violet', 'blue', 'teal'].includes(incoming.accentTheme)) portable.accentTheme = incoming.accentTheme;
        if (workerEfforts.includes(incoming.coordinatorEffort)) portable.coordinatorEffort = incoming.coordinatorEffort;
        if (typeof incoming.voiceName === 'string' && incoming.voiceName.length <= 60) portable.voiceName = incoming.voiceName;
        if (incoming.selectedProjectId === null || typeof incoming.selectedProjectId === 'string' && (await readJson(path.join(this.repo, 'projects', 'registry.json'), { projects: [] })).projects?.some(item => item.id === incoming.selectedProjectId)) portable.selectedProjectId = incoming.selectedProjectId;
        const settingsPath = path.join(this.stateDir, 'settings.json');
        const current = await readJson(settingsPath, {});
        if (await stat(settingsPath).catch(() => null)) { const saved = path.join(backup, 'state', 'settings.json'); await mkdir(path.dirname(saved), { recursive: true }); await copyFile(settingsPath, saved); }
        await saveJson(settingsPath, { ...current, ...portable });
        result.restoredSettings = portable;
      }
      const locationsPath = path.join(this.stateDir, 'project-locations.json');
      const locations = await readJson(locationsPath, {});
      for (const [id, repositories] of Object.entries(mapped)) {
        const current = locations[id] || {};
        const merged = { ...(current.repositories || {}), ...repositories };
        locations[id] = { ...current, repositories: merged, repositoryPath: merged.primary || Object.values(merged)[0] };
      }
      await saveJson(locationsPath, locations);
      for (const native of manifest.native) {
        const conflict = preview.native.find(item => item.agent === native.agent && item.id === native.id);
        if (conflict.status === 'unavailable') { result.nativeSkipped++; continue; }
        if (conflict.status === 'local-newer' || conflict.status === 'conflict' && !allowedNative.has(`${native.agent}:${native.id}`)) { result.nativeSkipped++; continue; }
        if (native.agent === 'opencode') {
          if (conflict.status === 'identical') { result.nativeSkipped++; continue; }
          const local = await this.openCode.read(native.id);
          if (openCodeHash(local) !== conflict.localHash) throw new Error('OpenCode changed during import. Preview again.');
          if (local) { await mkdir(path.join(backup, 'native', 'opencode'), { recursive: true }); await saveJson(path.join(backup, 'native', 'opencode', `${native.id}.json`), local); }
          const session = importedSessions.find(item => item.agent === 'opencode' && item.nativeId === native.id);
          const cwd = this.relocatedCwd(session, manifest, mapped);
          if (session.projectId && session.repositoryId === null) await mkdir(cwd, { recursive: true });
          await this.openCode.write(validateOpenCode(parseOpenCode(await readFile(extracted.get(native.name), 'utf8')), native.id), cwd, conflict.localHash, { backupDirectory: path.join(backup, 'native', 'opencode') });
          if (local) result.nativeUpdated++; else result.nativeImported++;
          continue;
        }
        let target;
        if (native.agent === 'codex') {
          if (!safePath(native.relative) || !native.relative.endsWith(`-${native.id}.jsonl`)) throw new Error('Invalid Codex transcript location.');
          target = conflict.local || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions', ...native.relative.split('/'));
        } else {
          const session = importedSessions.find(item => item.agent === 'claude' && item.nativeId === native.id);
          if (!session) throw new Error('Claude transcript has no matching chat.');
          const cwd = this.relocatedCwd(session, manifest, mapped);
          target = conflict.local || await claudeTranscript(cwd, native.id);
        }
        const current = await stat(target).catch(() => null);
        if ((current ? await digest(target) : null) !== conflict.localHash) throw new Error('A native conversation changed during import. Close its CLI and preview again.');
        if (conflict.status !== 'identical') {
          if (current) { const saved = path.join(backup, 'native', native.agent, `${native.id}.jsonl`); await mkdir(path.dirname(saved), { recursive: true }); await copyFile(target, saved); }
          await mkdir(path.dirname(target), { recursive: true });
          const staged = `${target}.${randomUUID()}.tmp`;
          await copyFile(extracted.get(native.name), staged); await rename(staged, target);
          if (current) result.nativeUpdated++; else result.nativeImported++;
        } else result.nativeSkipped++;
        if (native.agent === 'claude') for (const entry of manifest.files.filter(item => item.name.startsWith(`native/claude/${native.id}/`))) {
          const sidecarTarget = await claudeCompanionTarget(target, native.id, entry.name);
          const existing = await stat(sidecarTarget).catch(() => null);
          const previous = conflict.sidecars.find(item => item.name === entry.name);
          if ((existing ? await digest(sidecarTarget) : null) !== (previous?.localHash || null)) throw new Error('Claude companion data changed during import. Close its CLI and preview again.');
          if (existing && await digest(sidecarTarget) === entry.sha256) continue;
          if (existing) {
            const saved = path.join(backup, entry.name);
            await mkdir(path.dirname(saved), { recursive: true }); await copyFile(sidecarTarget, saved);
          }
          await mkdir(path.dirname(sidecarTarget), { recursive: true });
          const stagedSidecar = `${sidecarTarget}.${randomUUID()}.tmp`;
          await copyFile(extracted.get(entry.name), stagedSidecar); await rename(stagedSidecar, sidecarTarget);
        }
      }
      const targetSessions = [...currentSessions];
      let historyBackedUp = false;
      for (const session of importedSessions) {
        if (!session || !uuid.test(session.id) || !['codex', 'claude', 'opencode', 'kimi', 'shell'].includes(session.agent)) throw new Error('Archive contains invalid chat metadata.');
        const position = targetSessions.findIndex(item => item.id === session.id || session.nativeId && item.agent === session.agent && item.nativeId === session.nativeId);
        const existing = targetSessions[position];
        const native = preview.native.find(item => (item.key || `${item.agent}:${item.id}`) === nativeKey(session));
        // Never attach an incoming screen to a divergent/unimported native chat,
        // even when the destination has no Mr. Mik History entry yet.
        if (native?.agent === 'opencode' && ['conflict', 'local-newer'].includes(native.status)) { result.skipped++; continue; }
        const accepted = native && (['new', 'update'].includes(native.status) || native.status === 'conflict' && allowedNative.has(`${native.agent}:${native.id}`) || native.status === 'identical' && Date.parse(session.updatedAt) > Date.parse(existing?.updatedAt || '1970-01-01'));
        if (existing && !accepted) { result.skipped++; continue; }
        if (existing && !historyBackedUp) {
          await mkdir(path.join(backup, 'state'), { recursive: true });
          await saveJson(path.join(backup, 'state', 'sessions.json'), currentSessions);
          historyBackedUp = true;
        }
        const cwd = this.relocatedCwd(session, manifest, mapped);
        if (session.projectId && session.repositoryId === null && within(path.join(this.repo, 'workspace', 'planning'), cwd)) await mkdir(cwd, { recursive: true });
        const item = { ...session, id: existing?.id || session.id, cwd, open: false, status: 'stopped', restoreError: null, nativeUnavailable: native?.status === 'unavailable' ? native.reason : native ? null : session.nativeUnavailable || null };
        const screen = path.join(this.stateDir, `screen-${item.id}.json`);
        const incomingScreen = extracted.get(`state/screen-${session.id}.json`);
        if (existing && await stat(screen).catch(() => null)) {
          await mkdir(path.join(backup, 'state'), { recursive: true });
          await copyFile(screen, path.join(backup, 'state', `screen-${item.id}.json`));
        }
        // Never combine a newer transcript with an older saved terminal screen.
        if (incomingScreen) { await mkdir(this.stateDir, { recursive: true }); await copyFile(incomingScreen, screen); }
        else if (existing) await rm(screen, { force: true });
        if (existing) { targetSessions[position] = item; result.sessionsUpdated++; this.sessions.get(item.id).terminal?.dispose(); }
        else { targetSessions.push(item); result.imported++; }
        this.sessions.items.set(item.id, this.sessions.make(item));
        if (incomingScreen) await this.sessions.hydrate(this.sessions.get(item.id));
        this.sessions.changed(this.sessions.get(item.id));
      }
      if (targetSessions.length) {
        await saveJson(path.join(this.stateDir, 'sessions.json'), targetSessions);
        await this.sessions.persist();
      }
      if (extracted.has('state/mak-conversations.json')) {
        const target = path.join(this.stateDir, 'mak-conversations.json');
        const incoming = JSON.parse(await readFile(extracted.get('state/mak-conversations.json'), 'utf8'));
        const local = await readJson(target, { conversations: [], selected: {} });
        for (const conversation of incoming.conversations) {
          const missing = unavailable.find(item => item.key === `codex:${conversation.threadId}`);
          if (missing) conversation.nativeUnavailable = missing.reason;
        }
        // Missing incoming native contexts must never downgrade an existing local
        // coordinator conversation or attach its newer display history to it.
        incoming.conversations = incoming.conversations.filter(item => !item.nativeUnavailable || !local.conversations.some(old => old.id === item.id));
        const merged = mergeMakConversations(local, incoming);
        if (await stat(target).catch(() => null)) { await mkdir(path.join(backup, 'state'), { recursive: true }); await copyFile(target, path.join(backup, 'state', 'mak-conversations.json')); }
        await saveJson(target, merged);
      }
      if (incomingMak) {
        const target = path.join(this.stateDir, 'mak-history.json');
        const current = await readJson(target, { operations: [] });
        const merged = mergeMakHistory(current, incomingMak);
        if (await stat(target).catch(() => null)) { await mkdir(path.join(backup, 'state'), { recursive: true }); await copyFile(target, path.join(backup, 'state', 'mak-history.json')); }
        await saveJson(target, merged);
        result.makOperations = merged.operations.length;
      }
      result.nativeUnavailable = unavailable.length;
      return result;
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  relocatedCwd(session, manifest, mapped) {
    if (session.projectId && mapped[session.projectId]) {
      if (session.repositoryId === null) return path.join(this.repo, 'workspace', 'planning', session.projectId);
      return mapped[session.projectId][session.repositoryId] || session.cwd;
    }
    if (typeof session.cwd === 'string' && within(manifest.sourceHub, session.cwd)) return path.join(this.repo, path.relative(manifest.sourceHub, session.cwd));
    return session.cwd === manifest.sourceHub ? this.repo : session.cwd;
  }
}
