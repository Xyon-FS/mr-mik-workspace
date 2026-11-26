// Native per-thread MCP configuration acceptance, synthetic loopback backend.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexChatTransport } from '../codex-chat-transport.mjs';
import { graphicalCodexBinary } from '../codex-chat-binary.mjs';
import { codexThreadMcp } from '../codex-thread-mcp.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-thread-mcp-native-'));
const transport = new CodexChatTransport(), scopes = [], calls = [];
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const owner = request.headers.authorization === 'Bearer synthetic-A' ? 'A' : request.headers.authorization === 'Bearer synthetic-B' ? 'B' : null;
  response.setHeader('Content-Type', 'application/json');
  if (!owner) { response.writeHead(403); response.end('{}'); return; }
  const input = JSON.parse(body);
  if (input.action === 'tools') response.end(JSON.stringify({ tools: [{ name: 'browser_fixture_context', description: 'Synthetic context', inputSchema: { type: 'object', properties: {} } }] }));
  else if (input.action === 'call') response.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ owner }) }] }));
  else { assert.equal(input.name, 'mrmak_chat_context'); response.end(JSON.stringify({ owner })); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
  const home = path.join(root, 'home'); await mkdir(home);
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' });
  const allowed = new Set(['initialize', 'initialized', 'thread/start', 'mcpServerStatus/list', 'mcpServer/tool/call', 'thread/unsubscribe', 'thread/read']);
  const send = transport.send.bind(transport);
  transport.send = message => { assert.ok(allowed.has(message.method), `Forbidden acceptance RPC: ${message.method}`); calls.push(message.method); send(message); };
  const binary = graphicalCodexBinary();
  transport.start(binary.file, [...binary.args, 'app-server', '--stdio'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await transport.initialize();
  const ids = [];
  for (const owner of ['A', 'B']) {
    const scope = await codexThreadMcp({ stateDir: root, bridge: { script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), url: `http://127.0.0.1:${server.address().port}/bridge`, token: `synthetic-${owner}` }, browser: { shared: true, serverName: 'mr_mik_playwright_fixture', command: process.execPath, args: [fileURLToPath(new URL('../shared-browser-entry.mjs', import.meta.url))], env: { MRMIK_BROWSER_ENDPOINT: `http://127.0.0.1:${server.address().port}/shared-browser`, MRMIK_BROWSER_TOKEN: `synthetic-${owner}` } } });
    scopes.push(scope);
    assert.ok(!JSON.stringify(scope.config).includes(`synthetic-${owner}`));
    const result = await transport.rpc('thread/start', { cwd: root, config: scope.config }); ids.push(result.thread.id);
  }
  for (let i = 0; i < ids.length; i++) {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await transport.rpc('mcpServerStatus/list', { threadId: ids[i] });
      if (['mrmak_workspace', 'mr_mik_playwright_fixture'].every(name => status.data?.some(server => server.name === name && Object.keys(server.tools || {}).length))) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, 'Native scoped MCP tools did not become available');
    const result = await transport.rpc('mcpServer/tool/call', { threadId: ids[i], server: 'mrmak_workspace', tool: 'mrmak_chat_context', arguments: {} });
    const content = result.result?.content || result.content;
    assert.equal(JSON.parse(content[0].text).owner, ['A', 'B'][i]);
    const browserResult = await transport.rpc('mcpServer/tool/call', { threadId: ids[i], server: 'mr_mik_playwright_fixture', tool: 'browser_fixture_context', arguments: {} });
    assert.equal(JSON.parse((browserResult.result?.content || browserResult.content)[0].text).owner, ['A', 'B'][i]);
  }
  const unsubscribed = await transport.rpc('thread/unsubscribe', { threadId: ids[0] });
  assert.ok(['unsubscribed', 'notSubscribed', 'notLoaded'].includes(unsubscribed.status));
  assert.equal((await transport.rpc('thread/read', { threadId: ids[1], includeTurns: false })).thread.id, ids[1]);
  assert.equal(calls.filter(method => method === 'initialize').length, 1);
  console.log('PASS native per-thread MCP: same server names, separate private Bridge/browser descriptors/grants, A/B tool context isolation, unsubscribe leaves sibling usable, no credentials in native config, zero inference.');
} finally {
  await transport.close();
  await Promise.all(scopes.map(scope => scope.cleanup()));
  await new Promise(resolve => server.close(resolve));
  await cleanupFixtures();
}
