// Explicit V2 smoke: separate XDG/profile/temp roots, private server, local mock
// provider and real scoped Bridge transport. No login or paid model calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { terminalCommand } from '../agents.mjs';
import { lookupV2Session, forkV2Session } from '../opencode-v2-session.mjs';
import { OpenCodePicker } from '../opencode-picker.mjs';
import { workerControls } from '../worker-controls.mjs';
import { OpenCodeSettings } from '../opencode-settings.mjs';
import { parseAccountStatus } from '../accounts.mjs';
import { OpenCodeV2Transfer, v2Members, v2Hash, v2Relation } from '../opencode-v2-transfer.mjs';
import { OpenCodeTransfer } from '../opencode-transfer.mjs';
import { reviewAttachments, embedAttachments } from '../opencode-attachments.mjs';
import { pathToFileURL } from 'node:url';
import { openCodeLaunchEnvironment, openCodeStateFile, readOpenCodeState } from '../opencode.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const binary = path.join(repo, '.cache/opencode-v2/node_modules/@opencode/cli-windows-x64/bin/opencode.exe');
await mkdir(path.join(repo, '.cache'), { recursive: true });
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-v2-smoke-')));
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_TEST_HOME']) { env[key] = path.join(base, key); await mkdir(env[key]); }
env.MRMIK_OPENCODE_BINARY = binary;
env.OPENCODE_DISABLE_MODELS_FETCH = 'true'; env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
env.OPENCODE_PASSWORD = 'isolated-fixture-password';
const cwd = path.join(base, 'linked-project'), stateDir = path.join(base, 'Hub/.mrmak');
await mkdir(cwd); await mkdir(stateDir, { recursive: true });
let bridgeCalls = 0, providerCalls = 0, orientationSeen = false, slow = false, unavailable = false, processHandle, diagnostic = () => '';
let mcpAuthenticated = false;
const mcp = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString());
  mcpAuthenticated ||= req.headers.authorization === 'Bearer inherited-fixture';
  if (value.id == null) { res.writeHead(202); res.end(); return; }
  const result = value.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } } : { tools: [{ name: 'read_fixture', description: 'Read-only fixture', inputSchema: { type: 'object' } }] };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }));
});
const terminals = [];
async function launchTerminal(chat, prepared) {
  const terminal = new headless.Terminal({ cols: 110, rows: 40, allowProposedApi: true });
  const command = terminalCommand('opencode', { env: prepared.env, openCodeFamily: prepared.family, resumeId: prepared.nativeId, bypass: true });
  const proc = pty.spawn(command.file, command.args, { cwd, env: prepared.env, cols: 110, rows: 40, useConpty: true, useConptyDll: true });
  const item = { ...chat, agent: 'opencode', status: 'running', activity: 'idle', attention: false, process: proc, proc, terminal, openCodeLaunchId: prepared.launchId, exited: false };
  terminals.push(item);
  item.output = proc.onData(data => terminal.write(data));
  item.reply = terminal.onData(data => { if (!item.exited) proc.write(data); });
  proc.onExit(() => { item.exited = true; });
  item.screen = async () => {
    await new Promise(resolve => terminal.write('', resolve));
    return Array.from({ length: terminal.buffer.active.length }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) || '').join('\n');
  };
  await wait(async () => {
    const screen = await item.screen();
    if (item.exited) throw new Error(`Isolated V2 TUI exited: ${screen}`);
    return /Test|fixture\/test|Local fixture/i.test(screen);
  }, 'native terminal readiness');
  return item;
}
async function stopTerminal(item) {
  if (item.exited) return;
  item.proc.write('\x03'); await new Promise(resolve => setTimeout(resolve, 500));
  if (!item.exited) item.proc.write('\x03');
  await new Promise(resolve => setTimeout(resolve, 500));
  if (!item.exited) item.proc.kill();
}
const bridge = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-bridge-token');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (value.name === 'mrmak_chat_context') bridgeCalls++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ project: { id: 'workspace-fixture', name: 'Fixture Workspace' }, card: { id: 'card-fixture', title: 'Fixture Card' }, workingRepository: { name: 'Linked Fixture' } }));
});
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  orientationSeen ||= JSON.stringify(body.messages).includes('Fixture compact orientation');
  providerCalls++;
  if (unavailable) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture model unavailable', type: 'invalid_request_error', code: 'unsupported_country_region_territory' } })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: 'V2 local fixture answer.' }));
  if (!slow) res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
});
const wait = async (check, label) => {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  const state = await readOpenCodeState(openCodeStateFile(stateDir, 'v2-fixture'), 'v2-fixture');
  const events = await readFile(path.join(base, 'event-diagnostics.jsonl'), 'utf8').catch(() => '');
  throw new Error(`V2 isolated fixture timed out: ${label}. State=${JSON.stringify(state)}; fixture events=${events.slice(-6000)}; ${diagnostic()}`);
};
async function stopServer() {
  if (!processHandle || processHandle.exitCode != null) return;
  processHandle.stdin.end();
  let timer;
  try { await Promise.race([once(processHandle, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
  finally { clearTimeout(timer); }
  if (processHandle.exitCode == null) { processHandle.kill(); await once(processHandle, 'exit'); }
}
async function startServer(prepared) {
  let output = '', errors = '';
  processHandle = spawn(binary, ['serve', '--stdio', '--port', '0', '--print-logs'], { cwd, env: prepared.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  processHandle.stdout.on('data', data => { output += data; });
  processHandle.stderr.on('data', data => { errors = (errors + data).slice(-100000); });
  diagnostic = () => `Bridge calls=${bridgeCalls}, provider calls=${providerCalls}; ` + errors.split('\n').filter(line => /plugin|error|invalid|warn|config/i.test(line)).slice(-12).join('\n').replaceAll('fixture-bridge-token', '[redacted]').replaceAll('isolated-fixture-password', '[redacted]');
  return wait(() => {
    for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.url) return value; } catch { /* Waiting for native readiness. */ } }
    if (processHandle.exitCode != null) throw new Error(`Isolated server exited: ${diagnostic()}`);
  }, 'server readiness');
}
try {
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode'); await mkdir(configDir, { recursive: true });
  const pluginFolder = path.join(configDir, 'plugins', 'native-identity-fixture');
  await mkdir(pluginFolder, { recursive: true });
  await writeFile(path.join(pluginFolder, 'package.json'), JSON.stringify({ name: 'identity-package-fixture', type: 'module', exports: './index.mjs' }));
  env.MRMIK_FIXTURE_EVENTS = path.join(base, 'event-diagnostics.jsonl');
  // Record event identifiers only, never form fields/answers, prompts or auth.
  await writeFile(path.join(pluginFolder, 'index.mjs'), `import { appendFileSync } from 'node:fs';
export default { id: 'fixture.explicit.identity', setup(ctx) {
  const controller = new AbortController();
  const events = (async () => { for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
    if (!event.type.startsWith('form.') && !event.type.startsWith('session.execution.')) continue;
    const data = event.type === 'form.created' ? event.data?.form : event.data;
    appendFileSync(process.env.MRMIK_FIXTURE_EVENTS, JSON.stringify({ type: event.type, created: event.created, sessionID: data?.sessionID, id: data?.id }) + '\\n');
  } })();
  events.catch(() => {});
  return async () => { controller.abort(); await events.catch(() => {}); };
} };\n`);
  env.MRMIK_FIXTURE_AUTH = 'Bearer inherited-fixture';
  for (const [relative, name] of [['.opencode/skill/direct.md', 'Direct display label'], ['.opencode/skills/group/Folder.ID/SKILL.md', 'Nested display label'], ['custom-skills/relative/SKILL.md', 'Configured display label']]) {
    const file = path.join(cwd, relative); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\nname: ${name}\ndescription: Isolated fixture\n---\nFixture private skill instructions.\n`);
  }
  await writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ skills: ['./custom-skills'], mcp: { servers: { fixture: { type: 'remote', url: `http://127.0.0.1:${mcp.address().port}/mcp`, oauth: false, headers: { Authorization: '{env:MRMIK_FIXTURE_AUTH}' }, disabled: true } } } }));
  const nativeSettings = new OpenCodeSettings({ root: async () => cwd }, stateDir, { home: env.HOME, env, family: 2 });
  await nativeSettings.change({ projectId: 'fixture', scope: 'project', id: 'fixture', enabled: true });
  env.MRMAK_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}/bridge`;
  env.MRMAK_BRIDGE_TOKEN = 'fixture-bridge-token';
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ snapshots: false, model: 'fixture/test', enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Local fixture', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { test: { name: 'Test', reasoning: true, variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }, limit: { context: 8192, output: 256 } }, second: { name: 'Second', limit: { context: 8192, output: 256 } } } } } });
  const chat = { id: 'v2-fixture', cwd, nativeId: null };
  const prepared = await openCodeLaunchEnvironment(chat, stateDir, env, { script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), orientation: 'Fixture compact orientation', hubSkillNames: [] });
  assert.equal(prepared.family, 2);
  let ready = await startServer(prepared);
  const call = async (route, body) => {
    const response = await fetch(new URL(route, ready.url), { method: body ? 'POST' : 'GET', headers: { Authorization: `Basic ${Buffer.from('opencode:isolated-fixture-password').toString('base64')}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const created = await call('/api/session', { id: prepared.nativeId, title: 'Sacrificial V2 fixture', location: { directory: cwd } });
  const nativeId = created.data.id;
  const expectedSkillIds = ['direct', 'Folder.ID', 'relative'];
  const skillCatalog = await wait(async () => { const catalog = await call(`/api/skill?directory=${encodeURIComponent(cwd)}`); return expectedSkillIds.every(id => catalog.data.some(skill => skill.id === id)) && catalog; }, 'native skill catalog loading');
  for (const id of expectedSkillIds) assert.ok(skillCatalog.data.some(skill => skill.id === id), `Missing native skill ID ${id}: ${JSON.stringify(skillCatalog.data.map(skill => ({ id: skill.id, name: skill.name, path: skill.path })))}`);
  const configuredSkills = (await nativeSettings.list('fixture', 'primary')).rows.filter(row => row.kind === 'skill');
  for (const id of expectedSkillIds) assert.ok(configuredSkills.some(skill => skill.id === id), `Missing Mik skill ID ${id}`);
  console.log('V2 native skill catalog: direct Markdown, nested folder IDs and working-folder-relative sources match Mik discovery.');
  await call(`/api/session/${nativeId}/prompt`, { text: 'Respond with the local fixture answer.' });
  await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.nativeId === nativeId, 'native session ownership');
  await wait(() => bridgeCalls > 0, 'Bridge bootstrap');
  const mcpStatus = await call(`/api/mcp?directory=${encodeURIComponent(cwd)}`);
  assert.equal(mcpStatus.data.find(server => server.name === 'fixture')?.status?.status, 'connected', JSON.stringify(mcpStatus));
  assert.ok(mcpAuthenticated, 'Native merging must retain global headers without copying them to the project');
  console.log('V2 native configuration: project override connects MCP and retains inherited global headers.');
  const completed = await wait(async () => { const value = await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id); return value?.completion && value; }, 'completion');
  assert.equal(completed.preview, 'V2 local fixture answer.'); assert.ok(orientationSeen); assert.ok(providerCalls);
  if (!process.argv.includes('--transfer-only')) {
  const formRounds = process.argv.includes('--attention-stress') ? 12 : 1;
  for (let round = 0; round < formRounds; round++) {
  const form = await call(`/api/session/${nativeId}/form`, { title: 'Private fixture form', fields: [{ key: 'fixture', type: 'string', title: 'Private field' }] });
  await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.activity === 'waiting', 'native form attention');
  const formReply = await fetch(new URL(`/api/session/${nativeId}/form/${form.data.id}/reply`, ready.url), { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('opencode:isolated-fixture-password').toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: { fixture: 'Private answer' } }), signal: AbortSignal.timeout(15000) });
  assert.ok(formReply.ok);
  await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.activity === 'idle', 'native form reply settles');
  assert.equal((await readFile(openCodeStateFile(stateDir, chat.id), 'utf8')).includes('Private answer'), false);
  }
  console.log(`V2 native form creation/reply updates attention without retaining fields or answers (${formRounds} rounds).`);
  }
  const native = await call(`/api/session/${nativeId}`); assert.equal(native.data.id, nativeId);
  assert.equal(JSON.stringify(completed).includes('fixture-bridge-token'), false);
  await stopServer();
  const authResult = await promisify(execFile)(binary, ['auth', 'list', '--standalone', '--format', 'json'], { cwd, env, windowsHide: true, timeout: 30000 });
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: authResult.stdout }), 'logged-out');
  console.log('V2 auth status: isolated native metadata list returned logged-out; no login/logout or credential export was executed.');
  const callsBeforeResume = providerCalls;
  const resumed = await openCodeLaunchEnvironment({ ...chat, nativeId, hasConversation: true }, stateDir, env, { script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), orientation: 'Fixture compact orientation', hubSkillNames: [] });
  ready = await startServer(resumed);
  assert.equal((await call(`/api/session/${nativeId}`)).data.id, nativeId);
  assert.equal(providerCalls, callsBeforeResume, 'Resume must not replay a user prompt');
  orientationSeen = false;
  await call(`/api/session/${nativeId}/prompt`, { text: 'Second local fixture turn.' });
  const continuation = await wait(async () => { const state = await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id); return state?.launchId === resumed.launchId && state.completion && state; }, 'resumed completion');
  assert.equal(continuation.nativeId, nativeId); assert.notEqual(continuation.completion, completed.completion); assert.ok(orientationSeen);
  assert.equal((await lookupV2Session(nativeId, cwd, env)).id, nativeId);
  assert.equal(await lookupV2Session('ses_missing_fixture', cwd, env), null);
  await assert.rejects(lookupV2Session('../invalid', cwd, env), /Invalid/);
  console.log('V2 private server: Bridge bootstrap, scoped orientation, native ID, completion, preview and same-ID resume passed against local fixtures.');
  await stopServer();
  const transfer = new OpenCodeTransfer(cwd, { env, binary: { file: binary, args: [] }, family: 2 });
  const configBeforeTransfer = await readFile(path.join(configDir, 'opencode.json'), 'utf8');
  const exported = await transfer.read(nativeId);
  assert.equal(exported.format, 'opencode-v2'); assert.ok(exported.messages.length > 0);
  const targetRoot = path.join(base, 'transfer-target'); await mkdir(targetRoot);
  const targetEnv = { ...env, OPENCODE_DB: path.join(base, 'transfer-target.db') };
  const targetTransfer = new OpenCodeV2Transfer(targetRoot, { env: targetEnv, binary: { file: binary, args: [] } });
  await targetTransfer.write(exported, targetRoot, null);
  const transferred = await targetTransfer.read(nativeId);
  assert.equal(v2Relation(transferred, exported), 'identical');
  await targetTransfer.write(exported, targetRoot, v2Hash(transferred));
  const continuedArchive = structuredClone(exported);
  continuedArchive.messages.push({ id: 'msg_fixture_continuation', type: 'user', text: 'Transferred continuation fixture', time: { created: Date.now() } });
  const replacement = await targetTransfer.write(continuedArchive, targetRoot, v2Hash(transferred));
  assert.equal(v2Hash(JSON.parse(await readFile(replacement.backup, 'utf8'))), v2Hash(transferred));
  const continuedNative = await targetTransfer.read(nativeId);
  assert.equal(v2Relation(continuedNative, continuedArchive), 'identical');
  const failedArchive = structuredClone(continuedArchive);
  failedArchive.messages.push({ id: 'msg_fixture_failed_continuation', type: 'user', text: 'Failed continuation fixture', time: { created: Date.now() + 1 } });
  const nativeCommand = targetTransfer.command.bind(targetTransfer); let failOnce = true;
  targetTransfer.command = async (...args) => { if (args[0][1] === 'import' && failOnce) { failOnce = false; throw new Error('Injected isolated import failure'); } return nativeCommand(...args); };
  await assert.rejects(targetTransfer.write(failedArchive, targetRoot, v2Hash(continuedNative)), /original conversation was restored/);
  targetTransfer.command = nativeCommand;
  const restoredNative = await targetTransfer.read(nativeId); assert.equal(v2Relation(restoredNative, continuedNative), 'identical');
  console.log('V2 native continuation replacement retains its ID and backup; injected import failure restores the original native transcript.');
  await assert.rejects(targetTransfer.remove(nativeId, 'stale-review'), /changed/);
  await targetTransfer.remove(nativeId, v2Hash(restoredNative));
  assert.equal(await targetTransfer.read(nativeId), null);
  const media = structuredClone(exported), toolFile = path.join(base, 'fixture-tool.png');
  await writeFile(toolFile, Buffer.from([1, 2, 3, 4]));
  media.messages.find(message => message.type === 'user').files = [{ data: 'BQYH', mime: 'image/png', name: 'historical.png', source: { type: 'uri', uri: pathToFileURL(path.join(base, 'missing-historical.png')).href } }];
  media.messages.find(message => message.type === 'assistant').content.push({ type: 'tool', id: 'fixture-media-call', name: 'fixture_media', state: { status: 'completed', input: {}, content: [{ type: 'file', uri: pathToFileURL(toolFile).href, mime: 'image/png', name: 'fixture-tool.png' }] }, time: { created: 1, completed: 2 } });
  const reviewed = await reviewAttachments([media]); assert.equal(reviewed.length, 1);
  const embedded = await embedAttachments(media, reviewed);
  await targetTransfer.write(embedded, targetRoot, null);
  const roundtrip = await targetTransfer.read(nativeId); assert.equal(v2Relation(roundtrip, embedded), 'identical');
  assert.deepEqual(roundtrip.messages.find(message => message.type === 'user').files[0].source, { type: 'inline' });
  await targetTransfer.remove(nativeId, v2Hash(roundtrip));
  console.log('V2 native media transfer preserves historical prompt bytes and explicitly approved tool-file bytes in a separate DB.');
  assert.ok(await transfer.read(nativeId), 'Deleting the destination must not touch source data');
  assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), configBeforeTransfer, 'Native transfer must not rewrite source configuration');
  const forkId = await forkV2Session(nativeId, cwd, env);
  const forked = await transfer.read(forkId);
  assert.equal(forked.info.metadata.mrMikFork.sessionID, nativeId);
  assert.equal(forked.info.fork, undefined); assert.equal(forked.messages.length, exported.messages.length);
  await targetTransfer.write(forked, targetRoot, null);
  assert.equal(v2Relation(await targetTransfer.read(forkId), forked), 'identical');
  await targetTransfer.remove(forkId, v2Hash(await targetTransfer.read(forkId)));
  console.log('V2 fork transfer keeps its ID, copied history and provenance as an independent portable conversation.');
  for (const [id, parentID] of [['ses_fixture_child', nativeId], ['ses_fixture_grandchild', 'ses_fixture_child']]) {
    const member = structuredClone(exported); delete member.format;
    member.info.id = id; member.info.parentID = parentID; member.info.title = id;
    member.messages = [{ id: `msg_${id}`, type: 'user', text: 'Native child fixture', time: { created: Date.now() } }];
    const file = path.join(base, `${id}.json`); await writeFile(file, JSON.stringify(member));
    await transfer.v2().command(['session', 'import', file], cwd);
  }
  const family = await transfer.read(nativeId); assert.equal(v2Members(family).length, 3);
  let newFailChild = true;
  targetTransfer.command = async (...args) => { if (args[0][1] === 'import' && args[0][2].includes('ses_fixture_child') && newFailChild) { newFailChild = false; throw new Error('Injected fresh-family failure'); } return nativeCommand(...args); };
  await assert.rejects(targetTransfer.write(family, targetRoot, null), /confirmed partial imports were removed/);
  targetTransfer.command = nativeCommand; assert.equal(await targetTransfer.read(nativeId), null);
  await targetTransfer.write(family, targetRoot, null);
  assert.equal(v2Relation(await targetTransfer.read(nativeId), family), 'identical');
  const familyNext = structuredClone(family);
  familyNext.children[1].messages.push({ id: 'msg_grandchild_next', type: 'user', text: 'Family continuation', time: { created: Date.now() } });
  await targetTransfer.write(familyNext, targetRoot, v2Hash(await targetTransfer.read(nativeId)));
  assert.equal(v2Relation(await targetTransfer.read(nativeId), familyNext), 'identical');
  const failedFamily = structuredClone(familyNext); failedFamily.children[0].messages.push({ id: 'msg_child_failure', type: 'user', text: 'Failed family update', time: { created: Date.now() } });
  let failChild = true;
  targetTransfer.command = async (...args) => { if (args[0][1] === 'import' && args[0][2].includes('ses_fixture_child') && failChild) { failChild = false; throw new Error('Injected child import failure'); } return nativeCommand(...args); };
  await assert.rejects(targetTransfer.write(failedFamily, targetRoot, v2Hash(await targetTransfer.read(nativeId))), /original conversation was restored/);
  targetTransfer.command = nativeCommand;
  const restoredFamily = await targetTransfer.read(nativeId); assert.equal(v2Relation(restoredFamily, familyNext), 'identical');
  await assert.rejects(targetTransfer.remove(nativeId, v2Hash(family)), /changed/);
  await targetTransfer.remove(nativeId, v2Hash(restoredFamily));
  assert.equal(await targetTransfer.read(nativeId), null);
  assert.ok(await transfer.read(forkId), 'Source fork remains independent of destination family deletion');
  await transfer.remove(nativeId, v2Hash(await transfer.read(nativeId)));
  assert.equal(await transfer.read(nativeId), null);
  assert.equal((await transfer.read(forkId)).messages.length, forked.messages.length, 'Native recursive deletion of the parent must retain the independent fork history');
  console.log('V2 parent/child/grandchild transfer, family continuation, partial-import rollback and recursive deletion passed.');
  console.log('V2 native transfer: separate-DB import, folder relink, duplicate no-op, guarded deletion and source preservation passed.');
  if (process.argv.includes('--tui')) {
    const fresh = { id: 'v2-tui-fixture', cwd };
    const scopedBridge = { script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), orientation: 'Fixture compact orientation', hubSkillNames: [] };
    const runtime = await openCodeLaunchEnvironment(fresh, stateDir, env, scopedBridge);
    const tui = await launchTerminal(fresh, runtime);
    const initial = await wait(() => readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id), 'empty terminal identity');
    assert.equal(initial.nativeId, runtime.nativeId); assert.equal(initial.hasConversation, false);
    const sessions = { stateDir, get: id => terminals.find(item => item.id === id), input: (id, text) => sessions.get(id).proc.write(text), changed: () => {}, read: async id => ({ screen: await sessions.get(id).screen() }) };
    const picker = new OpenCodePicker(sessions), workers = workerControls(sessions, picker);
    try {
      const inventory = await picker.command(fresh.id, 'plugins');
      assert.ok(inventory.plugins.some(item => item.id === 'fixture.explicit.identity' && item.source.type === 'local'));
      assert.equal(inventory.plugins.some(item => item.source.type === 'builtin'), false);
      const skills = await picker.command(fresh.id, 'skills');
      for (const id of expectedSkillIds) assert.ok(skills.skills.some(skill => skill.id === id));
      assert.equal(JSON.stringify(skills).includes('Fixture private skill instructions'), false);
      console.log('V2 TUI skill metadata catalog is available without exposing instruction bodies.');
      console.log('V2 native plugin inventory confirms the actual plugin ID, independently of the package name.');
      const pluginSettings = new OpenCodeSettings({ root: async () => cwd }, stateDir, { home: env.HOME, env: { ...env, OPENCODE_CONFIG_CONTENT: undefined }, family: 2 });
      pluginSettings.observePlugins(cwd, inventory.plugins);
      await pluginSettings.change({ projectId: 'fixture', kind: 'plugin', name: 'fixture.explicit.identity', scope: 'project', enabled: false });
      await wait(async () => !(await picker.command(fresh.id, 'plugins')).plugins.some(item => item.id === 'fixture.explicit.identity'), 'native exact-ID disable');
      await pluginSettings.change({ projectId: 'fixture', kind: 'plugin', name: 'fixture.explicit.identity', scope: 'project', enabled: true });
      await wait(async () => (await picker.command(fresh.id, 'plugins')).plugins.some(item => item.id === 'fixture.explicit.identity'), 'native exact-ID re-enable');
      console.log('V2 native plugin exact-ID exclusion/re-enable passed without copying package options or sending a prompt.');
      const models = await picker.open(fresh.id);
      assert.equal(models.options.length, 2);
      const selected = await picker.choose(fresh.id, models.options.find(item => item.label === 'Second').slug);
      if (selected.variantMenu) {
        const options = await picker.openEffort(fresh.id);
        await picker.chooseEffort(fresh.id, options.options.find(item => item.label === 'Default').slug);
      }
      assert.ok((await tui.screen()).includes('Second'));
      const again = await picker.open(fresh.id);
      await picker.choose(fresh.id, again.options.find(item => item.label === 'Test').slug);
      const variants = await picker.openEffort(fresh.id);
      await picker.chooseEffort(fresh.id, variants.options.find(item => item.label === 'high').slug);
      tui.proc.write('Unsent fixture draft'); await new Promise(resolve => setTimeout(resolve, 250));
      await assert.rejects(workers.prepare(fresh.id), /empty native prompt/);
      tui.proc.write('\x15'); await new Promise(resolve => setTimeout(resolve, 250));
    } catch (error) { console.log('Isolated V2 control screen:', await tui.screen()); throw error; }
    const before = providerCalls; orientationSeen = false;
    await workers.send(fresh.id, 'Local terminal fixture prompt.');
    const answer = await wait(async () => { const state = await readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id); return state?.completion && state; }, 'terminal completion');
    assert.ok(providerCalls > before); assert.ok(orientationSeen); assert.equal(answer.nativeId, runtime.nativeId);
    const callsBeforeError = providerCalls;
    unavailable = true; await workers.send(fresh.id, 'Mock unavailable-model request.');
    await wait(async () => providerCalls > callsBeforeError && (await readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id))?.activity === 'idle', 'provider error settles');
    unavailable = false;
    tui.proc.resize(89, 68); tui.terminal.resize(89, 68); await new Promise(resolve => setTimeout(resolve, 300));
    const recovery = await picker.open(fresh.id);
    const recovered = await picker.choose(fresh.id, recovery.options.find(item => item.label === 'Second').slug);
    if (recovered.variantMenu) {
      const variants = await picker.openEffort(fresh.id);
      await picker.chooseEffort(fresh.id, variants.options.find(item => item.label === 'Default').slug);
    }
    assert.equal(tui.exited, false);
    console.log('V2 picker recovered after a mocked provider failure at a resized terminal width.');
    slow = true;
    await workers.send(fresh.id, 'Slow local fixture prompt.');
    await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id))?.activity === 'working', 'native running request');
    await workers.interrupt(fresh.id);
    await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id))?.activity === 'idle', 'native interrupt');
    assert.equal(tui.exited, false); slow = false;
    console.log('V2 controls: model/variant, draft protection, native submission and interrupt without restarting passed.');
    await stopTerminal(tui);
    const callsBefore = providerCalls;
    const resume = await openCodeLaunchEnvironment({ ...fresh, nativeId: answer.nativeId, hasConversation: true }, stateDir, env, scopedBridge);
    const continued = await launchTerminal(fresh, resume);
    assert.equal(providerCalls, callsBefore, 'TUI resume must not replay prompts');
    const resumedState = await wait(async () => { const state = await readOpenCodeState(openCodeStateFile(stateDir, fresh.id), fresh.id); return state?.launchId === resume.launchId && state; }, 'terminal resume identity');
    assert.equal(resumedState.nativeId, answer.nativeId); assert.equal(resumedState.hasConversation, true);
    await stopTerminal(continued);
    const forkChat = { id: 'v2-tui-fork', cwd, openCodeForkParent: answer.nativeId };
    const forkRuntime = await openCodeLaunchEnvironment(forkChat, stateDir, env, scopedBridge);
    await launchTerminal(forkChat, forkRuntime);
    const forkState = await wait(() => readOpenCodeState(openCodeStateFile(stateDir, forkChat.id), forkChat.id), 'terminal fork ownership');
    assert.notEqual(forkState.nativeId, answer.nativeId); assert.equal(forkState.hasConversation, true);
    console.log('V2 ConPTY: new empty chat, scoped orientation, prompt, same-ID resume without replay and distinct native fork passed.');
  }
} finally {
  await stopServer();
  for (const item of terminals) {
    for (const socket of [item.proc._socket, item.proc._agent?._inSocket]) socket?.on('error', error => {
      if (!['EAGAIN', 'EPIPE', 'ECONNRESET'].includes(error.code)) throw error;
    });
    await stopTerminal(item);
    item.output.dispose(); item.reply.dispose(); item.terminal.dispose();
    item.proc._agent?._conoutSocketWorker?.dispose(); item.proc._socket?.destroy(); item.proc._agent?._inSocket?.destroy();
  }
  bridge.closeAllConnections(); mock.closeAllConnections(); mcp.closeAllConnections();
  await Promise.all([new Promise(resolve => bridge.close(resolve)), new Promise(resolve => mock.close(resolve)), new Promise(resolve => mcp.close(resolve))]);
  await rm(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
