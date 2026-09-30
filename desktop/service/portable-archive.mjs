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

const included = ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.agents/skills', '.claude/skills'];
const uuid = /^[a-f0-9-]{36}$/i;
const safePath = value => typeof value === 'string' && value.length < 500 && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const safeArchivePath = name => {
  const skill = /^(?:\.agents|\.claude)\/skills\/(.+)$/.exec(name);
  return skill ? safePath(skill[1]) : safePath(name);
};
const privateName = value => /(^|\/)(?:\.env(?:\.|$)|auth|credentials?|tokens?|runtime|node_modules|target|cache)(?:[.\/-]|$)/i.test(value);
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
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
const accepted = name => safeArchivePath(name) && !privateName(name) && (included.some(folder => name.startsWith(`${folder}/`)) || /^state\/(?:sessions|settings|inbox|mak-history|mak-conversations|screen-[a-f0-9-]{36})\.json$/i.test(name) || /^native\/(?:codex|claude)\/[a-f0-9-]{36}\.jsonl$/i.test(name) || /^native\/claude\/[a-f0-9-]{36}\/.+/i.test(name));
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
  constructor(repo, stateDir, sessions, projects) { Object.assign(this, { repo, stateDir, sessions, projects }); }

  async exportTo(folder, { chats = 'full' } = {}) {
    if (!['full', 'light'].includes(chats)) throw new Error('Choose full or light chat export.');
    const destination = await realpath(folder);
    if (!(await stat(destination)).isDirectory() || within(this.repo, destination)) throw new Error('Choose an export folder outside the hub.');
    if (this.sessions.list().some(item => item.open)) throw new Error('Close all chat tabs before exporting a consistent workspace snapshot.');
    const entries = [];
    for (const relative of included) await walk(this.repo, relative, entries);
    const sessions = this.sessions.list();
    const settings = await readJson(path.join(this.stateDir, 'settings.json'), {});
    const portableSettings = Object.fromEntries(['defaultAgent', 'defaultBypass', 'defaultWorkerEffort', 'defaultClaudeWorkerEffort', 'terminalFontSize', 'terminalAppearance', 'accentTheme', 'coordinatorEffort', 'voiceName', 'selectedProjectId'].filter(key => key in settings).map(key => [key, settings[key]]));
    const stateFiles = { 'state/sessions.json': sessions, 'state/settings.json': portableSettings, 'state/inbox.json': await readJson(path.join(this.stateDir, 'inbox.json'), { resources: [] }) };
    stateFiles['state/mak-history.json'] = makHistory(await readJson(path.join(this.stateDir, 'mak-history.json'), { operations: [] }));
    const mak = makConversations(await readJson(path.join(this.stateDir, 'mak-conversations.json'), { conversations: [], selected: {} }));
    stateFiles['state/mak-conversations.json'] = mak;
    for (const [name, value] of Object.entries(stateFiles)) entries.push({ name, data: JSON.stringify(value) });
    for (const session of sessions) {
      const file = path.join(this.stateDir, `screen-${session.id}.json`);
      if (await stat(file).catch(() => null)) entries.push({ name: `state/screen-${session.id}.json`, source: file });
    }
    const locations = await readJson(path.join(this.stateDir, 'project-locations.json'), {});
    const native = [];
    if (chats === 'full') for (const session of [...sessions, ...mak.conversations.filter(item => item.threadId).map(item => ({ agent: 'codex', nativeId: item.threadId, cwd: this.repo, purpose: 'mak' }))]) {
      if (!uuid.test(session.nativeId || '') || !['codex', 'claude'].includes(session.agent)) continue;
      if (native.some(item => item.agent === session.agent && item.id === session.nativeId)) continue;
      const file = session.agent === 'codex' ? await codexTranscript(session.nativeId, { strict: true }) : await claudeTranscript(session.cwd, session.nativeId, { search: true });
      if (!file || !(await stat(file).catch(() => null))?.isFile()) continue;
      const name = `native/${session.agent}/${session.nativeId}.jsonl`;
      entries.push({ name, source: file });
      if (session.agent === 'claude') {
        const sidecar = path.join(path.dirname(file), session.nativeId);
        if (await stat(path.join(sidecar, '_mrmak-state')).catch(() => null)) throw new Error('Claude companion data uses a reserved transfer folder name. Resolve it before exporting.');
        if ((await stat(sidecar).catch(() => null))?.isDirectory() && within(await realpath(path.dirname(file)), await realpath(sidecar))) await walkNative(sidecar, `native/claude/${session.nativeId}`, entries);
        const root = await realpath(path.dirname(claudeRoot()));
        for (const kind of claudeStateKinds) {
          const folder = path.join(root, kind, session.nativeId);
          const actual = await realpath(folder).catch(() => null);
          if (actual && within(root, actual) && actual === folder && (await stat(folder)).isDirectory()) await walkNative(folder, `native/claude/${session.nativeId}/_mrmak-state/${kind}`, entries);
        }
      }
      const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      native.push({ agent: session.agent, id: session.nativeId, ...(session.purpose ? { purpose: session.purpose } : {}), name, sha256: await digest(file), cwd: session.cwd,
        relative: session.agent === 'codex' ? path.relative(path.join(codexRoot, 'sessions'), file).replaceAll('\\', '/') : null });
    }
    const projectPaths = Object.fromEntries(Object.entries(locations).map(([id, item]) => [id, item.repositories || { primary: item.repositoryPath }]));
    const projectRegistry = await readJson(path.join(this.repo, 'projects', 'registry.json'), { projects: [] });
    const projectNames = Object.fromEntries((projectRegistry.projects || []).map(item => [item.id, item.name]));
    const projectDefinitions = Object.fromEntries((projectRegistry.projects || []).map(item => [item.id, { name: item.name, repositories: item.repositories }]));
    const manifest = { format: 'mrmak-workspace', version: 1, createdAt: new Date().toISOString(), chats, sourceHub: this.repo, projectPaths, projectNames, projectDefinitions, native, files: [] };
    for (const entry of entries) {
      if (!accepted(entry.name) && !entry.name.startsWith('native/')) throw new Error('Unexpected export entry.');
      manifest.files.push({ name: entry.name, size: entry.source ? (await stat(entry.source)).size : Buffer.byteLength(entry.data), sha256: entry.source ? await digest(entry.source) : createHash('sha256').update(entry.data).digest('hex') });
    }
    const name = `MrMak-Workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.mrmak.zip`;
    const target = path.join(destination, name);
    await writeZip(target, [{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...entries]);
    return { path: target, files: entries.length, chats: native.length, bytes: (await stat(target)).size };
  }

  async preview(source) {
    const archive = await realpath(source);
    if (!(await stat(archive)).isFile() || !archive.toLowerCase().endsWith('.mrmak.zip')) throw new Error('Choose a Mr. Mik workspace archive.');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mrmak-import-'));
    try {
      const extracted = await extractZip(archive, temp);
      const manifest = JSON.parse(await readFile(extracted.get('manifest.json'), 'utf8'));
      if (extracted.has('state/mak-history.json')) makHistory(JSON.parse(await readFile(extracted.get('state/mak-history.json'), 'utf8')));
      const mak = extracted.has('state/mak-conversations.json') ? makConversations(JSON.parse(await readFile(extracted.get('state/mak-conversations.json'), 'utf8'))) : { conversations: [], selected: {} };
      mergeMakConversations(await readJson(path.join(this.stateDir, 'mak-conversations.json'), { conversations: [], selected: {} }), mak);
      if (manifest.format !== 'mrmak-workspace' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.native)) throw new Error('Unsupported workspace archive.');
      if (manifest.files.length !== extracted.size - 1) throw new Error('Archive file inventory does not match its manifest.');
      for (const file of manifest.files) {
        const actual = extracted.get(file.name);
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
      for (const session of sessions) if (!session || !uuid.test(session.id) || !['codex', 'claude', 'kimi', 'shell'].includes(session.agent)) throw new Error('Archive contains invalid chat metadata.');
      if (!manifest.projectPaths || typeof manifest.projectPaths !== 'object' || Array.isArray(manifest.projectPaths)) throw new Error('Archive has no project location map.');
      for (const [projectId, repositories] of Object.entries(manifest.projectPaths)) {
        if (!uuid.test(projectId) || !repositories || typeof repositories !== 'object' || Array.isArray(repositories)) throw new Error('Archive contains invalid project locations.');
        for (const [repositoryId, location] of Object.entries(repositories)) if (!/^[\w-]{1,100}$/.test(repositoryId) || ['__proto__', 'constructor', 'prototype'].includes(repositoryId) || typeof location !== 'string') throw new Error('Archive contains invalid repository locations.');
      }
      const native = [];
      for (const item of manifest.native) {
        if (!['codex', 'claude'].includes(item.agent) || !uuid.test(item.id) || item.name !== `native/${item.agent}/${item.id}.jsonl`) throw new Error('Invalid native session entry.');
        if (item.purpose === 'mak' ? item.agent !== 'codex' || !mak.conversations.some(conversation => conversation.threadId === item.id) : !sessions.some(session => session.agent === item.agent && session.nativeId === item.id)) throw new Error('Native transcript has no matching conversation in History.');
        if (item.agent === 'codex' && (!safePath(item.relative) || !item.relative.endsWith(`-${item.id}.jsonl`))) throw new Error('Invalid Codex transcript location.');
        if (manifest.files.find(file => file.name === item.name)?.sha256 !== item.sha256) throw new Error('Native session checksum does not match the archive.');
        const local = item.agent === 'codex' ? await codexTranscript(item.id, { strict: true }) : await findClaudeNative(item.id);
        const localHash = local && await stat(local).catch(() => null) ? await digest(local) : null;
        let status = !localHash ? 'new' : localHash === item.sha256 ? 'identical' : await transcriptRelation(local, extracted.get(item.name));
        // Claude subagent logs are part of the same conversation. A changed
        // existing sidecar also requires explicit replacement, not silent loss.
        const sidecars = [];
        if (item.agent === 'claude') {
          for (const entry of manifest.files.filter(file => file.name.startsWith(`native/claude/${item.id}/`))) {
            const transcript = local || await claudeTranscript(item.cwd, item.id);
            const target = await claudeCompanionTarget(transcript, item.id, entry.name);
            const hash = await stat(target).catch(() => null) ? await digest(target) : null;
            sidecars.push({ name: entry.name, localHash: hash });
            if (['new', 'update', 'identical'].includes(status) && hash && hash !== entry.sha256 && (!entry.name.endsWith('.jsonl') || await transcriptRelation(target, extracted.get(entry.name)) !== 'update')) status = 'conflict';
          }
        }
        native.push({ agent: item.agent, id: item.id, cwd: item.cwd, name: item.purpose === 'mak' ? `Mak · ${mak.conversations.find(conversation => conversation.threadId === item.id)?.title}` : sessions.find(session => session.agent === item.agent && session.nativeId === item.id)?.name, status, localHash, local, sidecars });
      }
      const hubConflicts = [];
      for (const file of manifest.files.filter(item => !item.name.startsWith('native/') && !/^state\/(?:sessions|mak-history|mak-conversations|screen-.*)\.json$/.test(item.name))) {
        const target = file.name.startsWith('state/') ? path.join(this.stateDir, file.name.slice(6)) : path.join(this.repo, ...file.name.split('/'));
        if (await stat(target).catch(() => null)) hubConflicts.push({ name: file.name, identical: await digest(target) === file.sha256 });
      }
      const localLocations = await readJson(path.join(this.stateDir, 'project-locations.json'), {});
      const suggestedRelinks = Object.fromEntries(Object.entries(manifest.projectPaths).map(([id, repositories]) => [id, Object.fromEntries(Object.entries(repositories).map(([key, value]) => [key, localLocations[id]?.repositories?.[key] || (key === 'primary' && localLocations[id]?.repositoryPath) || value]))]));
      return { manifest, native, hubConflicts, suggestedRelinks };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  async importFrom(source, { relinks = {}, replaceNative = [], replaceHub = [], restoreSettings = false } = {}) {
    if (this.sessions.list().some(item => item.open)) throw new Error('Close all chat tabs before importing.');
    const preview = await this.preview(source);
    const { manifest } = preview;
    const allowedNative = new Set(replaceNative);
    const allowedHub = new Set(replaceHub);
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
    const result = { imported: 0, skipped: 0, nativeImported: 0, nativeUpdated: 0, nativeSkipped: 0, sessionsUpdated: 0, backup };
    try {
      const extracted = await extractZip(await realpath(source), temp);
      const importedSessions = JSON.parse(await readFile(extracted.get('state/sessions.json'), 'utf8'));
      if (!Array.isArray(importedSessions)) throw new Error('Archive History is invalid.');
      const currentSessions = this.sessions.list();
      for (const entry of manifest.files) if (await digest(extracted.get(entry.name)) !== entry.sha256) throw new Error('Archive changed during import. Choose the archive again.');
      for (const session of importedSessions) {
        const existing = currentSessions.find(item => item.id === session.id);
        if (existing && (existing.agent !== session.agent || existing.nativeId !== session.nativeId)) throw new Error('A History ID belongs to a different conversation. Import into a fresh Hub.');
      }
      for (const item of preview.native) {
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
        if (['codex', 'claude', 'kimi', 'shell'].includes(incoming.defaultAgent)) portable.defaultAgent = incoming.defaultAgent;
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
        if (conflict.status === 'local-newer' || conflict.status === 'conflict' && !allowedNative.has(`${native.agent}:${native.id}`)) { result.nativeSkipped++; continue; }
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
        if (!session || !uuid.test(session.id) || !['codex', 'claude', 'kimi', 'shell'].includes(session.agent)) throw new Error('Archive contains invalid chat metadata.');
        const position = targetSessions.findIndex(item => item.id === session.id || session.nativeId && item.agent === session.agent && item.nativeId === session.nativeId);
        const existing = targetSessions[position];
        const native = preview.native.find(item => item.agent === session.agent && item.id === session.nativeId);
        const accepted = native && (['new', 'update'].includes(native.status) || native.status === 'conflict' && allowedNative.has(`${native.agent}:${native.id}`) || native.status === 'identical' && Date.parse(session.updatedAt) > Date.parse(existing?.updatedAt || '1970-01-01'));
        if (existing && !accepted) { result.skipped++; continue; }
        if (existing && !historyBackedUp) {
          await mkdir(path.join(backup, 'state'), { recursive: true });
          await saveJson(path.join(backup, 'state', 'sessions.json'), currentSessions);
          historyBackedUp = true;
        }
        const cwd = this.relocatedCwd(session, manifest, mapped);
        if (session.projectId && session.repositoryId === null && within(path.join(this.repo, 'workspace', 'planning'), cwd)) await mkdir(cwd, { recursive: true });
        const item = { ...session, id: existing?.id || session.id, cwd, open: false, status: 'stopped', restoreError: null };
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
        const merged = mergeMakConversations(await readJson(target, { conversations: [], selected: {} }), JSON.parse(await readFile(extracted.get('state/mak-conversations.json'), 'utf8')));
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
