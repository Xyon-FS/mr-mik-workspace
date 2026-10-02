// Explicit smoke test, not generic CI: isolated profile, localhost fake model only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCodeBinary } from '../agents.mjs';
import { openCodeLaunchEnvironment, readOpenCodeState, openCodeStateFile } from '../opencode.mjs';
import { createService } from '../server.mjs';
import { chatOrientation } from '../chat-orientation.mjs';
import http from 'node:http';
import { OpenCodeSettings, openCodeConfigDir } from '../opencode-settings.mjs';

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mr-mik-opencode-native-')));
const repo = path.join(base, 'hub'), stateDir = path.join(repo, '.mrmak');
for (const folder of ['workspace', 'projects', 'ui', 'inbox']) await mkdir(path.join(repo, folder), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
await writeFile(path.join(repo, 'ui/index.html'), '<html>Fixture</html>');
const service = await createService({ repo, uiDir: path.join(repo, 'ui'), restoreSessions: false });
const modelRequests = [];
const mock = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  modelRequests.push(JSON.parse(body));
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture-message', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(chunk({ role: 'assistant', content: 'Offline fixture response.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
let proc;
const eventAbort = new AbortController(), events = [];
try {
  const isolated = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    isolated[key] = path.join(base, key); await mkdir(isolated[key], { recursive: true });
  }
  isolated.OPENCODE_DISABLE_MODELS_FETCH = 'true';
  isolated.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  const working = path.join(base, 'working'); await mkdir(path.join(working, '.opencode/skills/native-report'), { recursive: true });
  await writeFile(path.join(working, '.opencode/skills/native-report/SKILL.md'), '---\nname: native-report\ndescription: Offline native reporting fixture\n---\nTest instructions.');
  const configDir = openCodeConfigDir({ home: isolated.HOME, env: isolated }); await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'opencode.jsonc'), '// native configuration fixture\n' + JSON.stringify({ permission: { skill: { 'native-report': 'deny' } }, mcp: { fixture_native: { type: 'local', command: [process.execPath, fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url))], enabled: false } } }));
  const settings = new OpenCodeSettings({ root: async () => working }, stateDir, { home: isolated.HOME, env: isolated });
  await settings.change({ projectId: 'fixture', repositoryId: 'primary', kind: 'mcp', name: 'fixture_native', enabled: true });
  await settings.change({ projectId: 'fixture', repositoryId: 'primary', kind: 'skill', name: 'native-report', enabled: true });
  isolated.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'fixture/test', enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Offline fixture', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { test: { name: 'Offline fixture', limit: { context: 8192, output: 256 } } } } } });
  const chat = { id: 'native-fixture', cwd: working, nativeId: null };
  const bridge = { script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), url: `${service.origin}/bridge`,
    token: service.bridge.issue(chat.id, null, null, null, 'opencode'), orientation: chatOrientation({}) };
  isolated.MRMAK_BRIDGE_URL = bridge.url; isolated.MRMAK_BRIDGE_TOKEN = bridge.token;
  const launch = await openCodeLaunchEnvironment(chat, stateDir, isolated, bridge);
  const binary = openCodeBinary();
  proc = spawn(binary.file, [...binary.args, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: working, env: launch.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; proc.stdout.on('data', chunk => { output += chunk; }); proc.stderr.on('data', chunk => { output += chunk; });
  const wait = async check => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; if (proc.exitCode !== null) throw new Error('Isolated OpenCode exited before the test completed.'); await new Promise(resolve => setTimeout(resolve, 200)); }
    throw new Error('Isolated OpenCode smoke test timed out.');
  };
  const origin = await wait(() => /https?:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]);
  const eventStream = await fetch(origin + '/event', { signal: eventAbort.signal });
  void (async () => {
    let buffer = '';
    for await (const chunk of eventStream.body) {
      buffer += Buffer.from(chunk).toString();
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = /^data: (.+)$/m.exec(packet)?.[1]; if (!data) continue;
        const event = JSON.parse(data), info = event.properties?.info;
        if (['message.updated', 'session.status', 'session.idle', 'session.error'].includes(event.type)) events.push({ type: event.type, id: event.properties?.sessionID || info?.sessionID, role: info?.role, finish: info?.finish, completed: info?.time?.completed, status: event.properties?.status?.type });
      }
    }
  })().catch(() => {});
  const request = async (route, body) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.ok, true, `Native request failed: ${route}`); return response.json();
  };
  const native = await request('/session', { title: 'Offline Mr Mik smoke test' });
  const observed = await wait(() => readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id));
  assert.equal(observed.nativeId, native.id); assert.equal(observed.launchId, launch.launchId); assert.equal(observed.hasConversation, false);
  const mcp = await wait(async () => { const status = await request('/mcp'); return status.mrmak_workspace?.status === 'connected' && status; });
  assert.equal(mcp.mrmak_workspace.status, 'connected');
  assert.equal(mcp.fixture_native.status, 'connected', 'Project On must override the globally disabled native MCP');
  const actualConfig = await request('/config');
  assert.equal(actualConfig.permission.skill['native-report'], 'allow', 'Native OpenCode must accept the generated skill permission');
  const sessions = await request('/session'); assert.equal(sessions.some(item => item.id === native.id), true);
  const reply = await request(`/session/${native.id}/message`, { model: { providerID: 'fixture', modelID: 'test' }, parts: [{ type: 'text', text: 'Offline verification. Reply with the fixture text; do not use tools.' }] });
  assert.equal(reply.info?.error, undefined); assert.equal(reply.info?.finish, 'stop');
  assert.equal(modelRequests.some(body => body.messages.some(message => message.role === 'system' && String(message.content).includes(bridge.orientation))), true, 'Actual model context must contain Hub orientation');
  assert.equal(modelRequests.some(body => body.tools?.some(tool => tool.function?.name?.includes('mrmak_add_card_page'))), true, 'Actual model request must discover scoped Bridge tools');
  try { await wait(async () => (await readOpenCodeState(openCodeStateFile(stateDir, chat.id), chat.id))?.preview === 'Offline fixture response.'); }
  catch (error) { console.log('Offline fixture event metadata:', JSON.stringify(events)); throw error; }
  console.log('PASS: native ID, scoped MCP connection, actual Hub orientation/tool discovery and final-turn observation using localhost mock only; no account or paid model.');
} finally {
  eventAbort.abort();
  if (proc && proc.exitCode === null) { proc.kill(); await new Promise(resolve => { proc.once('exit', resolve); setTimeout(resolve, 5000); }); }
  await service.close();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
}
