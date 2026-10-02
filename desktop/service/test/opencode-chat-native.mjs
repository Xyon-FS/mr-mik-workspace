// Explicit ConPTY smoke: native TUI, isolated profile, localhost mock only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { openCodeBinary } from '../agents.mjs';
import { openCodeLaunchEnvironment, openCodeStateFile, readOpenCodeState } from '../opencode.mjs';
import { OpenCodePicker } from '../opencode-picker.mjs';
import { workerControls } from '../worker-controls.mjs';

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-opencode-chat-'))), cwd = path.join(base, 'working'), stateDir = path.join(base, 'state');
await mkdir(cwd); await mkdir(stateDir);
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[key] = path.join(base, key); await mkdir(env[key]); }
env.OPENCODE_DISABLE_MODELS_FETCH = 'true'; env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
let slow = false, unavailable = false, calls = 0;
const mock = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* No prompt logging. */ }
  calls++;
  if (unavailable) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture model unavailable in this region', type: 'invalid_request_error', code: 'unsupported_country_region_territory' } })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: 'Local mock response.' }));
  if (!slow) res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const mcpCalls = [];
const mcpMock = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString()); mcpCalls.push(message.method);
  if (message.id == null) { res.writeHead(202); res.end(); return; }
  const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [{ name: 'read_fixture', description: 'Read-only fixture', inputSchema: { type: 'object' } }] };
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise(resolve => mcpMock.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(cwd, 'opencode.json'), JSON.stringify({ mcp: { fixture: { type: 'remote', url: `http://127.0.0.1:${mcpMock.address().port}/mcp`, oauth: false, enabled: true } } }));
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'fixture/test', enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Offline fixture', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { test: { name: 'Fixture Alpha', reasoning: true, variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }, limit: { context: 8192, output: 256 } }, second: { name: 'Fixture Beta', limit: { context: 8192, output: 256 } } } } } });
const items = new Map(), processes = [];
const sessions = { stateDir, get: id => items.get(id), input: (id, text) => items.get(id).process.write(text), read: async id => { const term = items.get(id).terminal; await new Promise(resolve => term.write('', resolve)); return { screen: Array.from({ length: term.buffer.active.length }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true) || '').join('\n') }; } };
const picker = new OpenCodePicker(sessions);
const nativeChoose = picker.choose.bind(picker);
picker.choose = async (id, slug) => { try { return await nativeChoose(id, slug); } catch (error) { console.log('Isolated fixture picker rows:', JSON.stringify(picker.rows(id, 'model'))); console.log(await picker.screen(id)); throw error; } };
sessions.changed = () => {};
const workers = workerControls(sessions, picker);
const wait = async check => { const until = Date.now() + 25000; while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('Native TUI fixture timed out.'); };
async function launch(id, parent) {
  const session = { id, agent: 'opencode', cwd, nativeId: null, openCodeForkParent: parent, status: 'running', activity: 'idle', attention: false, terminal: new headless.Terminal({ cols: 110, rows: 40, allowProposedApi: true }) };
  const runtime = await openCodeLaunchEnvironment(session, stateDir, env, null); session.openCodeLaunchId = runtime.launchId;
  const binary = openCodeBinary();
  session.process = pty.spawn(binary.file, [...binary.args, ...(parent ? ['--session', parent, '--fork'] : [])], { cwd, env: runtime.env, cols: 110, rows: 40, useConpty: true, useConptyDll: true });
  session.dataSubscription = session.process.onData(data => session.terminal.write(data)); session.process.onExit(() => { session.exited = true; }); processes.push(session.process); items.set(id, session);
  try { await wait(async () => (await sessions.read(id)).screen.includes('Fixture Alpha')); }
  catch (error) { console.log('Isolated native fixture startup:', (await sessions.read(id)).screen); throw error; }
  return session;
}
try {
  const chat = await launch('fixture-chat');
  await wait(async () => { try { return (await picker.command(chat.id, 'mcp-ready')).accepted; } catch { return false; } });
  const nativeProcess = chat.process;
  assert.equal((await picker.command(chat.id, 'mcp-refresh', { changes: [{ name: 'fixture', enabled: false }] })).accepted, true);
  assert.equal((await picker.command(chat.id, 'mcp-refresh', { changes: [{ name: 'fixture', enabled: true }] })).accepted, true);
  assert.equal(chat.process, nativeProcess);
  assert.ok(mcpCalls.includes('initialize')); assert.equal(mcpCalls.includes('tools/call'), false);
  console.log('Native OpenCode MCP Off/On verified without restart, provider requests or server tool invocation.');
  chat.process.write('unsent fixture draft');
  await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(picker.command(chat.id, 'mcp-ready'), /empty native prompt/);
  chat.process.write('\x15');
  await wait(async () => { try { return (await picker.command(chat.id, 'mcp-ready')).accepted; } catch { return false; } });
  let models;
  try { models = await picker.open(chat.id); } catch (error) { console.log((await sessions.read(chat.id)).screen); throw error; }
  assert.ok(models.options.some(row => row.label === 'Fixture Alpha'));
  const beta = models.options.find(row => row.label === 'Fixture Beta'); if (!beta) { console.log(JSON.stringify(models)); console.log((await sessions.read(chat.id)).screen); } assert.ok(beta);
  await picker.choose(chat.id, beta.slug);
  assert.ok((await sessions.read(chat.id)).screen.includes('Fixture Beta'));
  const again = await picker.open(chat.id), alpha = again.options.find(row => row.label === 'Fixture Alpha'); if (!alpha) { console.log(JSON.stringify(again)); console.log((await sessions.read(chat.id)).screen); } assert.ok(alpha); await picker.choose(chat.id, alpha.slug);
  const variants = await picker.openEffort(chat.id); assert.ok(variants.options.some(row => row.label === 'high'));
  await picker.chooseEffort(chat.id, variants.options.find(row => row.label === 'high').slug);
  chat.process.resize(89, 68); chat.terminal.resize(89, 68);
  await new Promise(resolve => setTimeout(resolve, 400));
  const narrowModels = await picker.open(chat.id);
  assert.equal(narrowModels.options.length, 2, 'Structured catalog does not depend on terminal width');
  await picker.choose(chat.id, narrowModels.options.find(row => row.label === 'Fixture Beta').slug);
  const narrowAgain = await picker.open(chat.id);
  await picker.choose(chat.id, narrowAgain.options.find(row => row.label === 'Fixture Alpha').slug);
  await workers.send(chat.id, 'Offline fixture prompt.');
  const completed = await wait(async () => { const state = await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id); return state?.completion && state; });
  chat.nativeId = completed.nativeId;
  await wait(async () => { try { return (await picker.command(chat.id, 'mcp-ready')).accepted; } catch { return false; } });
  const beforeFailure = calls;
  unavailable = true; await workers.send(chat.id, 'Offline provider error fixture.');
  await wait(async () => calls > beforeFailure && (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.activity === 'idle');
  unavailable = false; chat.activity = 'waiting'; chat.attention = true;
  let recovery;
  try { recovery = await picker.open(chat.id); } catch (error) { console.log('Recovery fixture viewport:', await picker.screen(chat.id)); console.log('Recovery fixture rows:', JSON.stringify(picker.rows(chat.id, 'model'))); throw error; }
  const recovered = recovery.options.find(row => row.label === 'Fixture Beta');
  assert.ok(recovered); await picker.choose(chat.id, recovered.slug);
  chat.activity = 'idle'; chat.attention = false;
  console.log('Native model picker recovered after a mocked region/provider failure without restart.');
  await writeFile(path.join(cwd, 'opencode.json'), JSON.stringify({ mcp: { fixture: { type: 'remote', url: `http://127.0.0.1:${mcpMock.address().port}/mcp`, oauth: false, enabled: false } } }));
  const disabledChat = await launch('fixture-disabled');
  await wait(async () => { try { return (await picker.command(disabledChat.id, 'mcp-ready')).accepted; } catch { return false; } });
  assert.equal((await picker.command(disabledChat.id, 'mcp-refresh', { changes: [{ name: 'fixture', enabled: true }] })).accepted, true, 'A server disabled at launch can be connected live');
  const fork = await launch('fixture-fork', chat.nativeId);
  const child = await wait(() => readOpenCodeState(openCodeStateFile(stateDir, fork.id), fork.id));
  assert.notEqual(child.nativeId, chat.nativeId); assert.equal(child.hasConversation, true);
  slow = true; await workers.send(chat.id, 'Slow offline fixture prompt.');
  await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.activity === 'working');
  await workers.interrupt(chat.id);
  await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.activity === 'idle');
  assert.ok(calls >= 2, 'User turns and optional native title generation use only the local mock.');
} finally {
  // ConPTY may report pending writes after the fixture begins shutting down.
  // Handle errors on these owned pipes only, without masking test assertions.
  for (const proc of processes) for (const socket of [proc._socket, proc._agent?._inSocket]) socket?.on('error', error => {
    if (!['EAGAIN', 'EPIPE', 'ECONNRESET'].includes(error.code)) throw error;
  });
  const mockClosed = new Promise(resolve => mock.close(resolve)); mock.closeAllConnections();
  for (const chat of items.values()) {
    try { chat.process.write('\x03'); await new Promise(resolve => setTimeout(resolve, 500)); if (!chat.exited) chat.process.write('\x03'); } catch { /* Fixture already exited. */ }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  for (const chat of items.values()) if (!chat.exited) { try { chat.process.kill(); } catch { /* Only fixture-owned processes. */ } }
  // ConPTY's output pipe can remain referenced after its native process exits.
  // Close only this fixture's pipe; never enumerate or stop user processes.
  for (const proc of processes) { proc._agent?._conoutSocketWorker?.dispose(); proc._socket?.destroy(); proc._agent?._inSocket?.destroy(); }
  for (const chat of items.values()) { chat.dataSubscription.dispose(); chat.terminal.dispose(); }
  await mockClosed;
  mcpMock.closeAllConnections(); await new Promise(resolve => mcpMock.close(resolve));
}
console.log('PASS: native model/variant selection without restart, submit, abort and exact fork identity. Local mock only; no account or paid calls.');
