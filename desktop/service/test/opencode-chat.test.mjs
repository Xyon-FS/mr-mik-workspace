import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodePicker } from '../opencode-picker.mjs';
import { createObserver } from '../opencode/observer.mjs';
import { tui } from '../opencode/tui-controls.mjs';
import { createService } from '../server.mjs';

test('OpenCode fork observation captures a fresh native root, not the source or unrelated child', () => {
  const states = [], directory = path.resolve('fixture');
  const observe = createObserver({ directory, forkParent: 'ses_source', chatId: 'fork', launchId: 'launch', save: state => states.push(state) });
  for (const info of [{ id: 'ses_source', directory }, { id: 'ses_child', directory, parentID: 'ses_other' }, { id: 'ses_wrong', directory: path.resolve('other') }]) observe({ type: 'session.created', properties: { info } });
  assert.equal(states.length, 0);
  observe({ type: 'session.created', properties: { info: { id: 'ses_fork', directory } } });
  assert.equal(states[0].nativeId, 'ses_fork'); assert.equal(states[0].hasConversation, true);
});

test('provider errors return the observer to idle, while permissions/questions still require input', () => {
  const states = [], observe = createObserver({ directory: process.cwd(), nativeId: 'ses_owned', chatId: 'fixture', launchId: 'launch', save: value => states.push(value) });
  const event = type => observe({ type, properties: { sessionID: 'ses_owned' } });
  event('session.error'); assert.equal(states.at(-1).activity, 'idle');
  observe({ type: 'message.updated', properties: { info: { sessionID: 'ses_owned', role: 'assistant', time: { completed: 1 }, error: { name: 'APIError' } } } });
  assert.equal(states.at(-1).activity, 'idle'); assert.equal(states.at(-1).completion, null);
  event('permission.asked'); assert.equal(states.at(-1).activity, 'waiting');
  event('session.idle'); assert.equal(states.at(-1).activity, 'waiting');
  event('question.asked'); assert.equal(states.at(-1).activity, 'waiting');
});

test('model picker ignores old menus in scrollback and recovers after stale observer attention', async () => {
  const terminal = new headless.Terminal({ cols: 110, rows: 12, allowProposedApi: true });
  await new Promise(resolve => terminal.write('Select model\r\nOld option\r\n' + 'History line\r\n'.repeat(30) + 'Provider unavailable in this region\r\nReady', resolve));
  const session = { agent: 'opencode', status: 'running', process: {}, terminal, openCodeLaunchId: 'launch', activity: 'waiting', attention: true };
  const picker = new OpenCodePicker({ get: () => session });
  assert.equal(picker.rows('fixture', 'model'), null);
  assert.equal((await picker.screen('fixture')).includes('Select model'), false);
  let called = false; picker.command = async (_id, action) => { if (action === 'catalog') return { models: [] }; assert.equal(action, 'model'); called = true; }; picker.until = async () => null;
  await assert.rejects(picker.openMenu('fixture', 'model'), /read safely/); assert.equal(called, true);
  assert.equal(picker.busy.size, 0); assert.equal(picker.openMenus.size, 0); terminal.dispose();
});

test('OpenCode picker recognizes colored native rows and refuses stale selections before sending keys', async () => {
  const terminal = new headless.Terminal({ cols: 110, rows: 40, allowProposedApi: true });
  const session = { agent: 'opencode', status: 'running', process: {}, terminal, openCodeLaunchId: 'launch', activity: 'idle' }, input = [];
  const sessions = { get: () => session, input: (_id, value) => input.push(value), read: async () => ({ screen: '' }) };
  const picker = new OpenCodePicker(sessions);
  const row = (y, x, style, text) => `\x1b[${y};${x}H${style}${text}\x1b[0m`;
  await new Promise(resolve => terminal.write('\x1b[2J' + row(12, 3, '', '┃ Prior chat') + row(12, 30, '\x1b[38;2;255;255;255m', 'Select model') + row(16, 30, '\x1b[38;2;100;100;100m', 'Fixture provider') + row(17, 28, '\x1b[38;2;0;0;0m\x1b[48;2;255;200;100m', '● Alpha') + row(17, 35, '\x1b[38;2;100;100;100m', ' Provider') + row(18, 30, '\x1b[38;2;255;255;255m', 'Beta') + row(18, 34, '\x1b[38;2;100;100;100m', ' Provider') + row(20, 30, '', 'Connect provider ctrl+a'), resolve));
  const rows = picker.rows('fixture', 'model'); assert.deepEqual(rows.map(item => item.label), ['Alpha', 'Beta']);
  picker.openMenus.set('fixture', { mode: 'model', process: session.process, options: rows });
  await assert.rejects(picker.chooseMenu('fixture', 'fake', 'model'), /visible/); assert.deepEqual(input, []);
  session.process = {};
  await assert.rejects(picker.chooseMenu('fixture', rows[1].slug, 'model'), /changed/); assert.deepEqual(input, []);
  terminal.dispose();
});

test('OpenCode TUI control validates launch/scope, dispatches native commands and aborts only its own conversation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-tui-control-')), file = path.join(base, 'request'), state = path.join(base, 'observer');
  const keys = ['MRMAK_OPENCODE_CONTROL', 'MRMAK_OPENCODE_LAUNCH_ID', 'MRMAK_OPENCODE_STATE'], previous = keys.map(key => process.env[key]);
  [process.env[keys[0]], process.env[keys[1]], process.env[keys[2]]] = [file, 'launch', state];
  await writeFile(state, JSON.stringify({ launchId: 'launch', nativeId: 'ses_owned' }));
  const commands = [], aborts = [], disposals = [];
  const api = { route: { current: { name: 'session', params: { sessionID: 'ses_other' } } }, keymap: { dispatchCommand: command => commands.push(command) }, ui: { dialog: { open: false } }, state: { ready: true, session: { status: () => ({ type: 'idle' }), permission: () => [], question: () => [] } }, client: { session: { abort: async args => { aborts.push(args.sessionID); return { data: true }; } } }, lifecycle: { onDispose: dispose => disposals.push(dispose) } };
  api.state.provider = [{ id: 'fixture', name: 'Offline fixture', options: { apiKey: 'never-transfer' }, models: { test: { name: 'Fixture Alpha', variants: { high: { privateOption: 'never-transfer' } } } } }];
  const request = async (id, action, extra = {}) => {
    await writeFile(file, JSON.stringify({ ...extra, id, action, launchId: 'launch', at: Date.now() }));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { const reply = await readFile(`${file}.reply`, 'utf8').then(JSON.parse).catch(() => null); if (reply?.id === id) return reply; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Fixture control timed out.');
  };
  try {
    await tui(api);
    assert.match((await request('wrong', 'interrupt')).error, /Return/); assert.deepEqual(aborts, []);
    api.route.current.params.sessionID = 'ses_owned';
    const catalog = await request('catalog', 'catalog'); assert.equal(catalog.models[0].label, 'Fixture Alpha'); assert.deepEqual(catalog.models[0].variants, ['high']); assert.equal(JSON.stringify(catalog).includes('never-transfer'), false); assert.deepEqual(commands, []);
    assert.equal((await request('ready', 'prepare')).accepted, true); assert.deepEqual(commands, []);
    assert.match((await request('no-focus', 'mcp-ready')).error, /empty native prompt/);
    api.renderer = { currentFocusedRenderable: { traits: { owner: 'opencode', role: 'prompt', capture: ['tab'] }, plainText: 'private draft' } };
    assert.match((await request('draft-mcp', 'mcp-ready')).error, /empty native prompt/);
    api.renderer.currentFocusedRenderable.plainText = '';
    assert.equal((await request('empty-mcp', 'mcp-ready')).accepted, true);
    const mcpCalls = [], liveState = { unity: { status: 'connected' } };
    api.client.mcp = { connect: async ({ name }) => { mcpCalls.push(['on', name]); liveState[name] = { status: 'connected' }; return { data: true }; }, disconnect: async ({ name }) => { mcpCalls.push(['off', name]); liveState[name] = { status: 'disabled' }; return { data: true }; }, status: async () => ({ data: liveState }) };
    assert.equal((await request('mcp-off', 'mcp-refresh', { changes: [{ name: 'unity', enabled: false }] })).accepted, true);
    assert.deepEqual(mcpCalls, [['off', 'unity']]);
    assert.match((await request('bridge-protected', 'mcp-refresh', { changes: [{ name: 'mrmak_workspace', enabled: false }] })).error, /Invalid/);
    api.ui.dialog.open = true;
    assert.match((await request('blocked-mcp', 'mcp-refresh', { changes: [{ name: 'unity', enabled: true }] })).error, /dialogs/); assert.equal(mcpCalls.length, 1);
    api.ui.dialog.open = false;
    assert.equal((await request('model', 'model')).accepted, true); assert.deepEqual(commands, ['model.list']);
    assert.equal((await request('abort', 'interrupt')).accepted, true); assert.deepEqual(aborts, ['ses_owned']);
    api.ui.dialog.open = true; assert.match((await request('dialog', 'submit')).error, /dialogs/); assert.equal(commands.length, 1);
    assert.match((await request('blocked-paste', 'prepare')).error, /dialogs/); assert.equal(commands.length, 1);
    api.ui.dialog.open = false;
    const dispatch = api.keymap.dispatchCommand; delete api.keymap.dispatchCommand;
    assert.match((await request('missing-dispatch', 'model')).error, /dispatch is unavailable/); assert.equal(commands.length, 1);
    assert.equal((await request('independent-abort', 'interrupt')).accepted, true);
    api.keymap.dispatchCommand = dispatch;
    delete api.state.session.permission;
    assert.match((await request('missing-readiness', 'submit')).error, /readiness checks/); assert.equal(commands.length, 1);
    api.state.provider = {};
    assert.match((await request('missing-catalog', 'catalog')).error, /catalog contract/);
    delete api.client.session.abort;
    assert.match((await request('missing-abort', 'interrupt')).error, /interruption is unavailable/);
    api.route.current = null;
    assert.match((await request('missing-route', 'model')).error, /contract is incompatible/);
  } finally { disposals.forEach(dispose => dispose()); keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test('OpenCode quick chat and fork preserve workspace/card/linked-folder scope without native transcript scanning', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-oc-chat-api-'))), repo = path.join(base, 'hub'), external = path.join(base, 'external');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(external);
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
  const service = await createService({ repo, uiDir: repo, restoreSessions: false });
  const request = (route, body) => fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const captured = [];
  try {
    const project = await service.projects.save({ name: 'Fixture', repositoryPath: external });
    const card = await service.projects.createCard({ projectId: project.id, repositoryId: 'primary', title: 'Models' });
    service.sessions.create = async options => { captured.push(options); const session = service.sessions.make({ ...options, id: `fixture-${captured.length}`, open: false, status: 'stopped' }); service.sessions.items.set(session.id, session); return session; };
    assert.equal((await request('/chats/quick', { agent: 'opencode', projectId: project.id, cardId: card.id })).status, 201);
    assert.equal(captured[0].cwd, external); assert.equal(captured[0].cardId, card.id); assert.equal(captured[0].effort, undefined);
    service.sessions.items.set('source', service.sessions.make({ ...captured[0], id: 'source', nativeId: 'ses_owned', hasConversation: true, open: false, activity: 'idle' }));
    assert.equal((await request('/sessions/source/fork', {})).status, 201);
    assert.equal(captured[1].resumeId, 'ses_owned'); assert.equal(captured[1].fork, true); assert.equal(captured[1].cardId, card.id); assert.equal(captured[1].cwd, external);
  } finally { service.sessions.items.clear(); await service.close(); }
});
