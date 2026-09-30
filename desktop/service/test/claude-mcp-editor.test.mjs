import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { ClaudeMcpEditor } from '../claude-mcp-editor.mjs';

test('Claude private project MCP editor isolates projects and leaves foreign config intact', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-mcp-'));
  const home = path.join(base, 'home'), stateDir = path.join(base, 'state');
  const first = path.join(base, 'first'), second = path.join(base, 'second');
  await Promise.all([home, stateDir, first, second].map(folder => mkdir(folder)));
  const file = path.join(home, '.claude.json');
  await writeFile(file, JSON.stringify({ accountId: 'private-fixture', mcpServers: { shared: { command: 'node', args: ['global'] } }, projects: { [second]: { mcpServers: { existing: { command: 'node', args: ['second'] } } } } }));
  const editor = new ClaudeMcpEditor({ root: async id => id === 'first' ? first : second }, stateDir, { home, env: {} });
  await editor.change({ projectId: 'first', action: 'save', name: 'private_one', transport: 'http', url: 'https://example.test/mcp', enabled: true });
  const listed = await editor.list('first');
  assert.deepEqual(listed.servers.map(server => server.name), ['private_one']);
  assert.equal(JSON.stringify(listed).includes('private-fixture'), false);
  assert.equal((await editor.list('second')).servers[0].managed, false);
  await editor.change({ projectId: 'first', action: 'toggle', name: 'private_one', enabled: false });
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(result.accountId, 'private-fixture');
  assert.equal(result.mcpServers.shared.command, 'node');
  assert.equal(result.projects[second].mcpServers.existing.args[0], 'second');
  assert.deepEqual(result.projects[first].disabledMcpServers, ['private_one']);
  assert.equal((await editor.list('first')).servers[0].enabled, false);
  await assert.rejects(editor.change({ projectId: 'second', action: 'remove', name: 'existing' }), /not managed/);
  await editor.change({ projectId: 'first', action: 'remove', name: 'private_one' });
  assert.deepEqual((await editor.list('first')).servers, []);
});

test('Claude MCP editor rejects overwriting foreign or externally changed definitions without leaking source', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-mcp-'));
  const home = path.join(base, 'home'), root = path.join(base, 'project');
  await mkdir(home); await mkdir(root);
  const editor = new ClaudeMcpEditor({ root: async () => root }, path.join(base, 'state'), { home, env: {} });
  const file = path.join(home, '.claude.json');
  await writeFile(file, JSON.stringify({ projects: { [root]: { mcpServers: { foreign: { command: 'secret-command' } } } } }));
  await assert.rejects(editor.change({ projectId: 'p', action: 'save', name: 'foreign', transport: 'stdio', command: 'node' }), /not managed/);
  await editor.change({ projectId: 'p', action: 'save', name: 'owned', transport: 'stdio', command: 'node' });
  const value = JSON.parse(await readFile(file, 'utf8'));
  value.projects[root].mcpServers.owned.command = 'changed-outside';
  await writeFile(file, JSON.stringify(value));
  assert.ok((await editor.list('p')).servers.every(item => item.managed === false));
  await assert.rejects(editor.change({ projectId: 'p', action: 'remove', name: 'owned' }), /changed outside/);
});

test('foreign global MCP can be parked, enabled locally and restored without losing private fields', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-off-'));
  const home = path.join(base, 'home'), root = path.join(base, 'project');
  await mkdir(home); await mkdir(root);
  const file = path.join(home, '.claude.json');
  const config = { type: 'stdio', command: 'node', args: ['fixture'], env: { PRIVATE_FIXTURE: 'not-a-real-secret' } };
  await writeFile(file, JSON.stringify({ unrelated: 'keep', mcpServers: { shared: config } }));
  const editor = new ClaudeMcpEditor({ root: async () => root }, path.join(base, 'state'), { home, env: {} });
  await editor.change({ scope: 'global', action: 'toggle', name: 'shared', enabled: false });
  let value = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(value.mcpServers.shared, undefined);
  assert.deepEqual(JSON.parse(await readFile(editor.disabledFile, 'utf8')).mcpServers.shared, config);
  assert.equal(JSON.stringify(await editor.list(null, null, 'global')).includes('not-a-real-secret'), false);
  await editor.change({ projectId: 'p', action: 'override', name: 'shared', enabled: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).projects[root].mcpServers.shared, config);
  await editor.change({ projectId: 'p', action: 'override', name: 'shared', enabled: null });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[root].mcpServers.shared, undefined);
  await editor.change({ scope: 'global', action: 'toggle', name: 'shared', enabled: true });
  value = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(value.mcpServers.shared, config);
  assert.equal(value.unrelated, 'keep');
});

test('Claude project-file MCP opt-out preserves the shared definition', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-project-'));
  const root = path.join(base, 'project'); await mkdir(root);
  const file = path.join(root, '.mcp.json'), source = JSON.stringify({ mcpServers: { shared: { type: 'stdio', command: 'node' } } });
  await writeFile(file, source);
  const editor = new ClaudeMcpEditor({ root: async () => root }, path.join(base, 'state'), { home: base, env: {} });
  await editor.change({ projectId: 'p', action: 'override', name: 'shared', enabled: false });
  assert.deepEqual((await editor.list('p')).disabledMcpServers, ['shared']);
  await editor.change({ projectId: 'p', action: 'override', name: 'shared', enabled: true });
  assert.deepEqual((await editor.list('p')).disabledMcpServers, []);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('Claude user scope is shared while a linked project can opt out without changing its definition', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-global-'));
  const home = path.join(base, 'home'), stateDir = path.join(base, 'state'), root = path.join(base, 'project');
  await Promise.all([home, stateDir, root].map(folder => mkdir(folder)));
  const editor = new ClaudeMcpEditor({ root: async () => root }, stateDir, { home, env: {} });
  await editor.change({ scope: 'global', action: 'save', name: 'shared', transport: 'http', url: 'https://example.test/mcp' });
  assert.deepEqual((await editor.list(null, null, 'global')).servers.map(item => item.name), ['shared']);
  await editor.change({ projectId: 'p', scope: 'local', action: 'override', name: 'shared', enabled: false });
  const file = path.join(home, '.claude.json');
  const off = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(off.mcpServers.shared.url, 'https://example.test/mcp');
  assert.deepEqual(off.projects[root].disabledMcpServers, ['shared']);
  await editor.change({ projectId: 'p', scope: 'local', action: 'override', name: 'shared', enabled: null });
  assert.deepEqual((await editor.list('p')).disabledMcpServers, []);
  await assert.rejects(editor.change({ scope: 'global', action: 'remove', name: 'foreign' }), /not managed/);
});
