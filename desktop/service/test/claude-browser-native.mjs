// Actual Claude -> scoped MCP proxy -> real Playwright, localhost model only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

if (!process.argv.includes('--run')) throw new Error('Pass --run for isolated native browser acceptance.');
const index = process.argv.indexOf('--portable'), serviceRoot = index < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[index + 1], 'App/runtime/service');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
let service, runtime, browserName, url, requests = 0;
const nativeEvents = []; let failure;
const server = http.createServer(async (request, response) => {
  try {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":42}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.end('{}'); return; }
  requests++; const input = JSON.parse(Buffer.concat(chunks));
  assert.ok(requests <= 3, 'Unexpected synthetic model work');
  const content = requests === 1 ? [{ type: 'tool_use', id: 'toolu_browser_navigate', name: `mcp__${browserName}__browser_navigate`, input: { url } }]
    : requests === 2 ? [{ type: 'tool_use', id: 'toolu_browser_screenshot', name: `mcp__${browserName}__browser_take_screenshot`, input: { type: 'png' } }]
      : [{ type: 'text', text: 'Synthetic browser checked successfully.' }];
  if (requests === 2) { const toolResults = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result'); assert.ok(JSON.stringify(toolResults).includes('Claude browser fixture'), 'Browser tool result missing local fixture marker: ' + JSON.stringify(toolResults).slice(0, 1000)); }
  if (requests === 3) assert.ok(JSON.stringify(input.messages).includes('image/'), 'Native screenshot image was not delivered to the model');
  const message = { id: `msg_browser_${requests}`, type: 'message', role: 'assistant', model: input.model, content, stop_reason: requests < 3 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 42, output_tokens: 10 } };
  if (input.stream) {
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    let body = event('message_start', { message: { ...message, content: [], stop_reason: null } });
    body += event('content_block_start', { index: 0, content_block: content[0].type === 'tool_use' ? { ...content[0], input: {} } : { type: 'text', text: '' } });
    body += event('content_block_delta', { index: 0, delta: content[0].type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } : { type: 'text_delta', text: content[0].text } });
    body += event('content_block_stop', { index: 0 });
    body += event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    response.end(body + event('message_stop', {}));
  } else response.end(JSON.stringify(message));
  } catch (error) { failure ||= error; response.writeHead(400); response.end(JSON.stringify({ error: {type: 'invalid_request_error', message: 'Synthetic native browser check failed'} })); }
});
async function wait(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (failure) throw failure; if (await check()) return; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(label);
}
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-browser-native-')), repo = path.join(root, 'hub'), home = path.join(root, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(home, key); await mkdir(env[key]); }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-local-browser-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
  service = await createService({ repo, uiDir: repo, mcpOptions: { home, env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: path.join(home, '.codex') } }, native: event => nativeEvents.push(event), profileOptions: { root: path.join(root, 'accounts') }, browserOptions: {
    launch: options => chromium.launch({ ...options, env: testBrowserEnvironment(), headless: true }),
    launchPersistent: (folder, options) => chromium.launchPersistentContext(folder, { ...options, env: testBrowserEnvironment(), headless: true }),
  } }, factory);
  service.sessions.captureTools = async () => ({});
  service.sessions.createGraphicalRuntime = options => {
    const scoped = Object.fromEntries(Object.entries(options.env).filter(([key]) => key.startsWith('MRMIK_BROWSER_') || key.startsWith('MRMAK_BRIDGE_')));
    runtime = new ClaudeChat({ ...options, env: { ...env, ...scoped } }); return runtime;
  };
  await service.browserSettings.change({ scope: 'global', choice: 'chrome' });
  const session = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, graphicalModel: 'haiku', effort: 'low' });
  const record = service.sharedBrowsers.get(session.id); browserName = runtime.browser.serverName;
  assert.ok(runtime.bridge.orientation.includes('managed Mr. Mik browser'));
  await wait(async () => JSON.stringify(await runtime.protocol.control({ subtype: 'mcp_status' })).includes(browserName) && JSON.stringify(await runtime.protocol.control({ subtype: 'mcp_status' })).includes('connected'), 'Native browser MCP not discovered');
  assert.equal(record.browser, undefined); assert.equal(requests, 0);
  const file = path.join(repo, 'browser-fixture.html'); await writeFile(file, '<title>Claude browser fixture</title><h1>Claude browser fixture</h1><button>Scoped local browser</button>'); url = service.files.url(file);
  const idBefore = session.nativeId, runtimeBefore = runtime;
  await runtime.submit('Inspect the synthetic local browser fixture and take one screenshot.');
  const approved = new Set();
  await wait(async () => {
    for (const request of runtime.snapshot().requests) {
      assert.ok([`mcp__${browserName}__browser_navigate`, `mcp__${browserName}__browser_take_screenshot`].includes(request.tool), 'Approve only the two synthetic fixture operations');
      approved.add(request.id); runtime.answer(request.id, 'allow');
    }
    return requests === 3 && runtime.snapshot().status === 'ready';
  }, 'Native browser turn did not complete');
  assert.ok(approved.size > 0, 'Native permissions must be surfaced, not bypassed');
  assert.equal(service.sessions.get(session.id).graphical, runtimeBefore); assert.equal(service.sessions.get(session.id).nativeId, idBefore);
  assert.ok(nativeEvents.some(event => event.type === 'window' && event.window === 'workspace'));
  assert.equal(record.context.pages()[0].url(), url);
  const item = runtime.snapshot().items.find(item => item.resources?.some(resource => resource.kind === 'image'));
  assert.ok(item); const resource = item.resources.findIndex(resource => resource.kind === 'image');
  const response = await fetch(`${service.origin}/api/sessions/${session.id}/chatresult?item=${encodeURIComponent(item.id)}&resource=${resource}&preview=true`, { headers: { Authorization: `Bearer ${service.token}` } });
  assert.ok(response.ok, await response.clone().text()); assert.match((await response.json()).url, /^data:image\/png;base64,/);
  await runtime.persistState(); assert.doesNotMatch(await readFile(runtime.file, 'utf8'), /iVBORw0KGgo/);
  const token = record.token;
  await service.sharedBrowsers.action(record, { action: 'owner', owner: 'user' });
  await assert.rejects(service.sharedBrowsers.call(record, 'browser_snapshot'), /user controls/);
  service.sharedBrowsers.hide(record);
  assert.equal(record.owner, 'agent'); assert.equal(requests, 3);
  await service.sessions.remove(session.id); assert.throws(() => service.sharedBrowsers.authenticate(token), /expired/);
  console.log('PASS actual Claude browser MCP discovery/environment, native approvals, navigate/screenshot via real Playwright, Workspace routing, image result preview without persisted binary, manual ownership, same agent/session and grant revocation. Localhost model simulator only; zero real provider calls.');
} finally {
  await service?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
