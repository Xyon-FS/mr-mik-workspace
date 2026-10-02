import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { ToolRefresh, mcpSnapshot, changedMcps, emptyNativePrompt } from '../tool-refresh.mjs';
import { McpInventory } from '../mcp.mjs';
import { Sessions } from '../sessions.mjs';
import { createService } from '../server.mjs';
import { codexCommandFixture } from './cli-fixture.mjs';
import { nativeRefreshSnapshot } from '../native-refresh-snapshot.mjs';

const entry = (enabled = true, definition = 'one') => ({ name: 'unity', enabled, definition, plugin: false });
function fixture(t, agents = ['codex']) {
  const items = new Map(agents.map((agent, index) => [String(index), { id: String(index), agent, open: true, process: {}, activity: 'idle', nativeId: `native-${index}`, hasConversation: true, lastInputAt: null }]));
  const targets = new Map([...items.keys()].map(id => [id, { unity: entry() }]));
  const restarts = [], connections = [];
  const sessions = { items, get: id => items.get(id), changed: () => {} };
  const adapter = { snapshot: async session => targets.get(session.id), ready: async () => true, live: async (session, changes) => { connections.push([session.id, changes]); }, restart: async session => { restarts.push(session.id); refresh.launched(session, targets.get(session.id)); }, delay: 60000 };
  const refresh = new ToolRefresh(sessions, adapter); t.after(() => refresh.close());
  for (const session of items.values()) refresh.launched(session, targets.get(session.id));
  return { refresh, items, targets, restarts, connections };
}

test('MCP fingerprints ignore key order, disabled definitions and inherited no-op changes', async () => {
  assert.deepEqual(changedMcps({ unity: entry(false) }, { unity: entry(false, 'changed') }), []);
  assert.deepEqual(changedMcps({ unity: entry(true) }, { unity: entry(true) }), []);
  assert.deepEqual(changedMcps({ unity: entry(true) }, {}), ['unity']);
  assert.deepEqual(changedMcps({}, { unity: entry(true) }), ['unity']);
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-mcp-refresh-')), home = path.join(base, 'home'), repo = path.join(base, 'repo');
  await mkdir(path.join(home, '.codex'), { recursive: true }); await mkdir(path.join(repo, '.codex'), { recursive: true });
  const global = path.join(home, '.codex/config.toml');
  await writeFile(global, '[mcp_servers.unity]\nurl="https://example.com"\nenabled=true\nhttp_headers={Authorization="private-fixture"}\n');
  await writeFile(path.join(repo, '.codex/config.toml'), '[mcp_servers.unity]\nenabled=true\n');
  const inventory = new McpInventory(repo, { home, env: {} });
  const before = mcpSnapshot(await inventory.scan(), 'codex');
  await writeFile(global, '[mcp_servers.unity]\nhttp_headers={Authorization="private-fixture"}\nenabled=false\nurl="https://example.com"\n');
  const after = mcpSnapshot(await inventory.scan(), 'codex');
  assert.deepEqual(changedMcps(before, after), []);
  assert.equal(JSON.stringify(before).includes('private-fixture'), false);
  assert.equal(JSON.stringify(before).includes('example.com'), false);
});

test('only effective changes in the affected client resume a conversation', async t => {
  const f = fixture(t, ['codex', 'claude', 'opencode']);
  f.targets.set('0', { unity: entry(false) });
  await f.refresh.scan(); await f.refresh.poll();
  assert.deepEqual(f.restarts, ['0']); assert.deepEqual(f.connections, []);
  assert.equal(f.items.get('0').nativeId, 'native-0');
  assert.equal(f.items.get('1').toolRefresh, null);
  assert.equal(f.items.get('0').toolRefresh.status, 'applied');
});

test('OpenCode existing On/Off uses native connection controls without restart', async t => {
  const f = fixture(t, ['opencode']); f.targets.set('0', { unity: entry(false) });
  await f.refresh.scan(); await f.refresh.poll();
  assert.deepEqual(f.connections, [['0', [{ name: 'unity', enabled: false }]]]); assert.deepEqual(f.restarts, []);
  f.targets.set('0', { unity: entry(true, 'new definition') });
  await f.refresh.scan(); await f.refresh.poll(); assert.deepEqual(f.restarts, ['0']);
});

test('busy turns, drafts and native menus stay pending until a safe manual apply', async t => {
  const f = fixture(t); const chat = f.items.get('0');
  chat.activity = 'working'; f.targets.set('0', { unity: entry(false) });
  await f.refresh.scan(); chat.activity = 'idle'; await f.refresh.poll();
  assert.deepEqual(f.restarts, []); assert.equal(chat.toolRefresh.status, 'pending');
  f.refresh.ready = async () => false;
  assert.equal((await f.refresh.apply('0')).pending, true); assert.deepEqual(f.restarts, []);
  f.refresh.ready = async () => true;
  assert.equal((await f.refresh.apply('0')).applied, true); assert.deepEqual(f.restarts, ['0']);
});

test('a missing OpenCode live MCP contract uses guarded resume, not guessed input', async t => {
  const f = fixture(t, ['opencode']); f.items.get('0').liveMcpAvailable = false;
  f.targets.set('0', { unity: entry(false) }); await f.refresh.scan(); await f.refresh.poll();
  assert.deepEqual(f.restarts, ['0']); assert.deepEqual(f.connections, []);
});

test('missing native IDs and failed native operations never cause restart loops', async t => {
  const f = fixture(t); f.items.get('0').nativeId = null; f.targets.set('0', { unity: entry(false) });
  await f.refresh.scan(); await f.refresh.poll(); await f.refresh.poll(); assert.deepEqual(f.restarts, []);
  f.items.get('0').nativeId = 'native-0'; f.refresh.restart = async () => { throw new Error('fixture'); };
  await assert.rejects(f.refresh.apply('0'), /fixture/);
  await f.refresh.poll(); assert.equal(f.items.get('0').toolRefresh.status, 'failed');
});

test('input racing a readiness check prevents any mutation', async t => {
  const f = fixture(t); f.targets.set('0', { unity: entry(false) });
  f.refresh.ready = async session => { session.lastInputAt = 'changed'; return true; };
  await f.refresh.scan(); await f.refresh.poll(); assert.deepEqual(f.restarts, []);
});

test('settings written during a refresh are compared again against the applied baseline', async t => {
  const f = fixture(t, ['opencode']); f.targets.set('0', { unity: entry(false) });
  f.refresh.live = async () => { f.targets.set('0', { unity: entry(true, 'changed') }); await f.refresh.scan(); };
  await f.refresh.scan(); await f.refresh.poll();
  assert.equal(f.items.get('0').toolRefresh.status, 'pending');
  await f.refresh.poll(); assert.deepEqual(f.restarts, ['0']);
});

test('reverted settings clear pending updates; native skills are not wrapped', async t => {
  const f = fixture(t); const editor = { set: async (_id, change) => ({ saved: true, kind: change.kind }) };
  f.refresh.wrap(editor, 'set', (_id, change) => change.kind === 'mcp');
  f.targets.set('0', { unity: entry(false) }); await editor.set(null, { kind: 'skill' });
  assert.equal(f.items.get('0').toolRefresh, null);
  await editor.set(null, { kind: 'mcp' }); assert.equal(f.items.get('0').toolRefresh.status, 'pending');
  f.targets.set('0', { unity: entry(true) }); await f.refresh.scan();
  assert.equal(f.items.get('0').toolRefresh, null); assert.equal(f.refresh.pending.size, 0);
});

test('terminal readiness uses the live cursor and rejects multiline drafts', async () => {
  const terminal = new headless.Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  try {
    await write('› Ask Codex to do anything'); assert.equal(emptyNativePrompt({ agent: 'codex', terminal }), true);
    await write('\r\x1b[2K› unfinished draft'); assert.equal(emptyNativePrompt({ agent: 'codex', terminal }), false);
    await write('\r\x1b[2K› \r\nsecond line\x1b[1A\r'); assert.equal(emptyNativePrompt({ agent: 'codex', terminal }), false);
    await write('\x1b[?1049h❯ '); assert.equal(emptyNativePrompt({ agent: 'claude', terminal }), false);
  } finally { terminal.dispose(); }
});

test('guarded resume keeps native ID and working associations, blocks input during close, and excludes runtime status from disk', async t => {
  await codexCommandFixture(t);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-refresh-resume-'));
  const sessions = await new Sessions(repo, path.join(repo, 'state')).init();
  t.after(() => sessions.close());
  const transcript = path.join(repo, 'fixture.jsonl'); await writeFile(transcript, '{}\n');
  const chat = sessions.make({ id: 'fixture', name: 'Fixture', agent: 'codex', cwd: repo, projectId: 'workspace', repositoryId: 'unity', cardId: 'card', nativeId: 'native-id', hasConversation: true, open: true, activity: 'idle', bypass: false, effort: 'high' });
  const exitHandlers = [];
  const proc = { onExit: callback => { exitHandlers.push(callback); return { dispose() {} }; } };
  chat.process = proc; chat.launchedCodexPermissions = chat.codexPermissions; sessions.items.set(chat.id, chat);
  sessions.nativeBoundary = async () => ({ file: transcript, offset: 3 });
  let previews = 0, resumed;
  sessions.prepareLaunch = async (_chat, options) => { assert.equal(options.preview, true); previews++; return null; };
  sessions.requestStop = current => {
    assert.throws(() => sessions.input(current.id, 'do not lose this'), /being applied/);
    current.process = null; exitHandlers.forEach(callback => callback());
  };
  sessions.resume = async (id, nativeId) => { resumed = { id, nativeId, cardId: chat.cardId, repositoryId: chat.repositoryId, cwd: chat.cwd, bypass: chat.bypass, effort: chat.effort }; };
  await sessions.restartTools(chat, { process: proc, inputAt: undefined });
  assert.equal(previews, 1);
  assert.deepEqual(resumed, { id: 'fixture', nativeId: 'native-id', cardId: 'card', repositoryId: 'unity', cwd: repo, bypass: false, effort: 'high' });
  chat.toolRefresh = { status: 'pending', reason: 'Runtime only', automatic: true };
  await sessions.persist(); assert.equal((await readFile(path.join(repo, 'state/sessions.json'), 'utf8')).includes('toolRefresh'), false);
  const restored = sessions.make({ ...chat, toolRefresh: { status: 'pending' } }); assert.equal(restored.toolRefresh, null);
});

test('UI and Bridge use shared MCP editor notifications; preview launch leaves the existing Bridge grant intact', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-refresh-api-')), home = path.join(base, 'home'), repo = path.join(base, 'hub'), linked = path.join(base, 'unity');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(path.join(home, '.codex'), { recursive: true }); await mkdir(linked);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.unity]\nurl="https://example.com/mcp"\nenabled=true\n');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home, env: {} } }); t.after(async () => { service.sessions.items.clear(); await service.close(); });
  const project = await service.projects.save({ name: 'Fixture', repositoryPath: linked });
  const chat = service.sessions.make({ id: 'fixture', agent: 'codex', name: 'Fixture', projectId: project.id, repositoryId: 'primary', cwd: linked, open: true, activity: 'working', nativeId: 'native', hasConversation: true });
  chat.process = {}; service.sessions.items.set(chat.id, chat);
  await nativeRefreshSnapshot(chat, repo, path.join(repo, '.mrmak'), { home, env: {} });
  service.toolRefresh.launched(chat, await service.toolRefresh.capture(chat));
  const grant = await service.sessions.prepareLaunch(chat);
  const preview = await service.sessions.prepareLaunch(chat, { preview: true });
  assert.equal(preview.token, ''); assert.equal(service.bridge.grants.has(grant.token), true);
  const result = await service.bridge.call(grant.token, 'mrmak_manage_tool', { action: 'codex-switch', kind: 'mcp', name: 'unity', scope: 'project', enabled: false, confirmed: true });
  await nativeRefreshSnapshot(chat, repo, path.join(repo, '.mrmak'), { home, env: {} });
  assert.equal(result.saved, true); assert.equal(chat.toolRefresh.status, 'pending'); assert.equal(chat.toolRefresh.automatic, false);
  assert.equal(service.bridge.grants.has(grant.token), true);
  service.toolRefresh.launched(chat, await service.toolRefresh.capture(chat));
  await service.projects.createSkill({ target: 'linked', agent: 'codex', projectId: project.id, repositoryId: 'primary', name: 'native-fixture', description: 'Fixture', instructions: 'Fixture instructions' });
  assert.equal(chat.toolRefresh.status, 'pending');
  assert.equal(chat.toolRefresh.automatic, false);
});
