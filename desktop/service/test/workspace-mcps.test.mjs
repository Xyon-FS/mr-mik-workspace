import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { resolveWorkspaceMcps, WorkspaceMcpLaunches } from '../workspace-mcps.mjs';
import { ToolRefresh } from '../tool-refresh.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-workspace-mcp-'));
  const home = path.join(base, 'home'), main = path.join(base, 'main'), child = path.join(base, 'unity'), peer = path.join(base, 'peer');
  await Promise.all([home, main, child, peer].map(folder => mkdir(folder)));
  const repositories = [{ id: 'primary', name: 'Main', repositoryPath: main, available: true }, { id: 'unity', name: 'Unity', repositoryPath: child, available: true }];
  const project = { id: 'workspace', repositories };
  const projects = { get: async id => { assert.equal(id, 'workspace'); return project; }, root: async (id, repositoryId) => repositoryId === 'primary' ? main : repositoryId === 'peer' ? peer : child };
  const session = { id: 'session', agent: 'claude', projectId: 'workspace', repositoryId: 'primary', cwd: main };
  const options = { home, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } };
  const config = { type: 'stdio', command: process.execPath, args: ['fixture.mjs'], env: { PRIVATE_FIXTURE: 'synthetic-secret' } };
  const json = (file, value) => writeFile(file, JSON.stringify(value));
  await json(path.join(home, '.claude.json'), { unrelated: 'preserve', projects: { [child]: { mcpServers: { UnityMCP: config } } } });
  return { base, home, main, child, peer, repositories, projects, session, options, config, json };
}

test('main chats compose eligible linked MCPs and respect opt-outs and conflicting origins', async () => {
  const f = await fixture();
  const result = await resolveWorkspaceMcps(f.projects, f.session, f.options);
  assert.equal(result.origins.length, 1); const name = result.origins[0].name;
  assert.equal(name, 'UnityMCP'); assert.equal(result.definitions[name].cwd, f.child);
  assert.equal(result.definitions[name].env.PRIVATE_FIXTURE, 'synthetic-secret');
  assert.doesNotMatch(JSON.stringify(result.snapshot), /synthetic-secret|fixture.mjs/);
  assert.deepEqual((await resolveWorkspaceMcps(f.projects, { ...f.session, cwd: f.child, repositoryId: 'unity' }, f.options)).definitions, {});
  assert.deepEqual((await resolveWorkspaceMcps(f.projects, { ...f.session, projectId: null }, f.options)).definitions, {});
  await f.json(path.join(f.home, '.claude.json'), { projects: { [f.child]: { mcpServers: { UnityMCP: f.config }, disabledMcpServers: ['UnityMCP'] } } });
  assert.deepEqual((await resolveWorkspaceMcps(f.projects, f.session, f.options)).definitions, {});
  await f.json(path.join(f.home, '.claude.json'), { projects: { [f.main]: { disabledMcpServers: ['UnityMCP'] }, [f.child]: { mcpServers: { UnityMCP: f.config } } } });
  // A main-side opt-out must apply even when the definition only exists in a sibling.
  const disabled = await resolveWorkspaceMcps(f.projects, f.session, f.options);
  assert.equal(Object.keys(disabled.definitions).length, 0);
  await f.json(path.join(f.home, '.claude.json'), { projects: { [f.peer]: { mcpServers: { UnityMCP: { ...f.config, args: ['other.mjs'] } } }, [f.child]: { mcpServers: { UnityMCP: f.config } } } });
  f.repositories.push({ id: 'peer', name: 'Peer', repositoryPath: f.peer, available: true });
  const added = await resolveWorkspaceMcps(f.projects, f.session, f.options);
  assert.equal(added.origins.length, 0); assert.equal(Object.keys(added.definitions).length, 0); assert.match(added.issues[0].reason, /Conflicting/);
  assert.notDeepEqual(added.snapshot, result.snapshot);
  f.repositories.splice(1, 1);
  const removed = await resolveWorkspaceMcps(f.projects, f.session, f.options); assert.equal(removed.origins[0].repositoryId, 'peer');
});

test('graphical Codex linked reads preserve scope and freshness without foreign provider failures', async () => {
  const f = await fixture();
  await mkdir(path.join(f.home, '.codex')); await mkdir(path.join(f.child, '.codex')); await mkdir(path.join(f.main, '.codex'));
  const user = '[mcp_servers.UnityMCP]\ncommand=' + JSON.stringify(process.execPath) + '\nenabled=false\n';
  const trust = `[projects.${JSON.stringify(f.child)}]\ntrust_level="trusted"\n`;
  await writeFile(path.join(f.home, '.codex/config.toml'), user);
  const linked = path.join(f.child, '.codex/config.toml');
  await writeFile(linked, '[mcp_servers.UnityMCP]\nenabled=true\ndisabled_tools=["danger"]\n');
  const session = { ...f.session, agent: 'codex', chatInterface: 'chat' };
  const untrusted = await resolveWorkspaceMcps(f.projects, session, f.options);
  assert.equal(untrusted.issues.length, 1);
  assert.deepEqual(untrusted.definitions, {});
  await writeFile(path.join(f.home, '.codex/config.toml'), user + trust);
  const full = await resolveWorkspaceMcps(f.projects, { ...session, chatInterface: 'cli' }, f.options);
  assert.deepEqual(Object.keys(full.definitions), ['UnityMCP']);
  assert.deepEqual(full.definitions.UnityMCP.nativePolicy.disabled_tools, ['danger']);
  assert.deepEqual(await resolveWorkspaceMcps(f.projects, session, f.options), full);
  await writeFile(path.join(f.child, '.mcp.json'), '{ broken Claude file');
  await writeFile(path.join(f.child, 'opencode.json'), '{ broken OpenCode file');
  assert.deepEqual(await resolveWorkspaceMcps(f.projects, session, f.options), full);
  await assert.rejects(resolveWorkspaceMcps(f.projects, { ...session, chatInterface: 'cli' }, f.options), /unreadable/);
  await writeFile(linked, '[mcp_servers.UnityMCP]\nenabled=false\n');
  assert.deepEqual((await resolveWorkspaceMcps(f.projects, session, f.options)).definitions, {});
  await writeFile(linked, '[mcp_servers.UnityMCP]\nenabled=true\n');
  await writeFile(path.join(f.main, '.codex/config.toml'), '[mcp_servers.UnityMCP]\nenabled=false\n');
  assert.deepEqual((await resolveWorkspaceMcps(f.projects, session, f.options)).definitions, {});
  await writeFile(linked, 'invalid selected file [');
  await assert.rejects(resolveWorkspaceMcps(f.projects, session, f.options), /unreadable/);
});

test('sharing retains Claude MCP deny/ask rules without importing unrelated permissions or grants', async () => {
  const f = await fixture(); await mkdir(path.join(f.child, '.claude'));
  await f.json(path.join(f.child, '.claude/settings.local.json'), { permissions: { deny: ['mcp__UnityMCP__danger', 'Bash(*)'], ask: ['mcp__*'], allow: ['mcp__UnityMCP__*'] } });
  const resolved = await resolveWorkspaceMcps(f.projects, f.session, f.options);
  assert.deepEqual(resolved.claudePermissions, { deny: ['mcp__UnityMCP__danger'], ask: ['mcp__UnityMCP__*'] });
  assert.equal(resolved.origins[0].name, 'UnityMCP');
});

test('silent refresh waits through active turns and drafts, resumes the exact chat, and does not replay failed updates', async () => {
  const session = { id: 's', agent: 'claude', process: {}, open: true, activity: 'working', nativeId: 'same-native', hasConversation: true };
  const sessions = { items: new Map([['s', session]]), get: () => session, changed: () => {} };
  let definitions = {}, empty = false, restarts = 0, fail = false;
  const refresh = new ToolRefresh(sessions, { delay: 60000, silent: () => true, watch: true, snapshot: async () => definitions, ready: async () => empty, restart: async () => { restarts++; if (fail) throw new Error('failed'); refresh.launched(session, definitions); } });
  try {
    refresh.launched(session, {}); definitions = { linked: { enabled: true, definition: 'new' } };
    await refresh.scan(); await refresh.poll(); assert.equal(restarts, 0); assert.equal(session.toolRefresh.silent, true);
    session.activity = 'idle'; await refresh.poll(); assert.equal(restarts, 0);
    empty = true; await refresh.poll(); assert.equal(restarts, 1); assert.equal(session.nativeId, 'same-native'); assert.equal(session.toolRefresh.silent, true);
    fail = true; definitions = {}; refresh.lastScan = 0; await refresh.poll(); assert.equal(restarts, 2); assert.equal(session.toolRefresh.silent, false);
    refresh.lastScan = 0; await refresh.poll(); assert.equal(restarts, 2);
  } finally { refresh.close(); }
});

test('linked MCP host uses origin cwd and private launch data; descriptors are cleaned after closure', async () => {
  const f = await fixture();
  const script = path.join(f.child, 'fixture.mjs');
  // The generated fixture imports the same installed SDK by absolute URL.
  const serverUrl = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js', import.meta.url).href;
  const transportUrl = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', import.meta.url).href;
  const typesUrl = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js', import.meta.url).href;
  await writeFile(script, `import {Server} from ${JSON.stringify(serverUrl)}; import {StdioServerTransport} from ${JSON.stringify(transportUrl)}; import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(typesUrl)}; const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'where',inputSchema:{type:'object'}}]}));s.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),value:process.env.PRIVATE_FIXTURE,roots:(await s.listRoots()).roots})}]}));await s.connect(new StdioServerTransport());`);
  const launches = new WorkspaceMcpLaunches(path.join(f.base, 'state')), resolved = await resolveWorkspaceMcps(f.projects, f.session, f.options);
  const defs = await launches.prepare(f.session, resolved), native = Object.values(defs)[0];
  assert.doesNotMatch(JSON.stringify(defs), /synthetic-secret/);
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: native.command, args: native.args, stderr: 'ignore' });
  try {
    await client.connect(transport); assert.equal((await client.listTools()).tools[0].name, 'where');
    const output = JSON.parse((await client.callTool({ name: 'where', arguments: {} })).content[0].text);
    assert.equal(output.cwd.toLowerCase(), f.child.toLowerCase()); assert.equal(output.value, 'synthetic-secret'); assert.ok(output.roots[0].uri.includes('/unity'));
  } finally { await client.close(); await launches.close(); }
  assert.deepEqual(await readdir(launches.folder), []);
});

test('HTTP linked MCP relay forwards native tools and credentials without exposing them in launch arguments', async () => {
  const f = await fixture(), requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString()); requests.push([message.method, request.headers.authorization]);
    if (message.id == null) { response.writeHead(202); response.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'Synthetic result' }] } : message.method === 'resources/list' ? { resources: [] } : { prompts: [] };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launches = new WorkspaceMcpLaunches(path.join(f.base, 'state')); let client;
  try {
    await f.json(path.join(f.home, '.claude.json'), { projects: { [f.child]: { mcpServers: { httpFixture: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'synthetic-private-header' } } } } } });
    const resolved = await resolveWorkspaceMcps(f.projects, f.session, f.options), defs = await launches.prepare(f.session, resolved), native = Object.values(defs)[0];
    assert.doesNotMatch(JSON.stringify(defs), /synthetic-private-header/);
    client = new Client({ name: 'test', version: '1' }); await client.connect(new StdioClientTransport({ command: native.command, args: native.args, stderr: 'ignore' }));
    assert.equal((await client.listTools()).tools.length, 1); assert.equal((await client.callTool({ name: 'read', arguments: {} })).content[0].text, 'Synthetic result');
    assert.deepEqual((await client.listResources()).resources, []); assert.deepEqual((await client.listPrompts()).prompts, []);
    assert.ok(requests.every(([, auth]) => auth === 'synthetic-private-header'));
  } finally { await client?.close(); await launches.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('SSE linked MCP relay retains configured authentication on both discovery and messages', async () => {
  const f = await fixture(), auth = [], native = new Server({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
  native.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'sse_fixture', inputSchema: { type: 'object' } }] }));
  let transport, client; const launches = new WorkspaceMcpLaunches(path.join(f.base, 'state'));
  const server = http.createServer(async (request, response) => {
    auth.push(request.headers.authorization);
    if (request.url === '/sse') { transport = new SSEServerTransport('/messages', response); await native.connect(transport); }
    else if (request.method === 'POST' && transport) await transport.handlePostMessage(request, response);
    else { response.writeHead(405); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await f.json(path.join(f.home, '.claude.json'), { projects: { [f.child]: { mcpServers: { sseFixture: { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse`, headers: { Authorization: 'synthetic-sse-secret' } } } } } });
    const resolved = await resolveWorkspaceMcps(f.projects, f.session, f.options), definitions = await launches.prepare(f.session, resolved), entry = definitions.sseFixture;
    client = new Client({ name: 'test', version: '1' }); await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, stderr: 'ignore' }));
    assert.equal((await client.listTools()).tools[0].name, 'sse_fixture'); assert.ok(auth.length >= 3); assert.ok(auth.every(value => value === 'synthetic-sse-secret'));
  } finally { await client?.close(); await native.close(); await launches.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
