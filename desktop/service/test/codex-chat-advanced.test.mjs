import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { Sessions } from '../sessions.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-advanced-'));
  const transport = graphicalFixture(options);
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'auto-review', accountProfileId: 'fixture', effort: 'medium' }, env: { ...process.env, CODEX_HOME: root }, spawnChild: transport.spawnChild });
  t.after(async () => { await runtime.close(); for (const child of transport.children) child.kill(); }); await runtime.start();
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, ...params } });
  return { runtime, transport, notify };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(2); } assert.ok(predicate(), 'Synthetic state did not settle'); }

test('Plan/Build uses discovered native modes, acknowledged settings and selected model/effort without permission changes', async t => {
  const { runtime: r, transport } = await fixture(t, { completeBeforeResponse: true });
  assert.equal(r.advanced.snapshot().mode, 'default');
  await r.submit('Synthetic Build default');
  assert.equal(transport.calls.find(call => call.method === 'turn/start').params.collaborationMode.mode, 'default');
  assert.equal(r.advanced.modes.length, 2); await r.advanced.selectMode('plan');
  const setting = transport.calls.find(call => call.method === 'thread/settings/update').params;
  assert.deepEqual(setting.collaborationMode, { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'medium', developer_instructions: null } });
  assert.equal(setting.approvalPolicy, undefined); await r.submit('Plan the task');
  assert.deepEqual(transport.calls.findLast(call => call.method === 'turn/start').params.collaborationMode, setting.collaborationMode);
  assert.equal(r.session.codexPermissions, 'auto-review'); await assert.rejects(r.advanced.selectMode('invented'), /available mode/);
});
test('queue edits/removals and receipts are single-use, and native completion starts the next request once', async t => {
  const { runtime: r, transport, notify } = await fixture(t, { approval: true });
  notify('turn/started', { turn: { id: 'busy', status: 'inProgress' } });
  r.draft = 'Next request'; r.advanced.enqueue('Next request', 'request-fixture-0001');
  assert.equal(r.draft, ''); assert.equal(r.ready(), false);
  const entry = r.advanced.queue[0]; r.advanced.edit(entry.id, 'Edited next request');
  r.advanced.enqueue('ignored duplicate', 'request-fixture-0001'); assert.equal(r.advanced.queue.length, 1);
  r.advanced.enqueue('Remove me', 'request-fixture-0002'); r.advanced.cancel(r.advanced.queue[1].id); assert.equal(r.advanced.queue.length, 1);
  r.draft = 'Newer unsent work';
  r.draftRevision++;
  r.attachments = [path.join(r.session.cwd, 'newer.txt')];
  notify('turn/completed', { turn: { id: 'busy', status: 'completed' } });
  await until(() => transport.calls.some(call => call.method === 'turn/start'));
  await until(() => !r.advanced.dispatching);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(transport.calls.find(call => call.method === 'turn/start').params.input[0].text, 'Edited next request');
  r.advanced.enqueue('ignored after delivery', 'request-fixture-0001'); assert.equal(r.advanced.queue.length, 0);
  assert.equal(r.draft, 'Newer unsent work');
  assert.deepEqual(r.attachments, [path.join(r.session.cwd, 'newer.txt')]);
});

test('uncertain steer is never converted into a queued/new request and can reconcile only a new user item in the expected turn', async t => {
  const { runtime: r, notify } = await fixture(t);
  notify('turn/started', { turn: { id: 'active', status: 'inProgress', startedAt: 10 } });
  r.rpc = async () => { throw new Error('Synthetic timeout'); }; r.draft = 'Guide';
  await assert.rejects(r.advanced.steer('Guide', 'active'), /timeout/); assert.equal(r.uncertain, true); assert.equal(r.draft, 'Guide');
  r.rpc = async method => { assert.equal(method, 'thread/read'); return { thread: { turns: [{ id: 'active', status: 'completed', startedAt: 10, items: [{ id: 'guide-new', type: 'userMessage', content: [{ type: 'text', text: 'Guide' }] }] }] } }; };
  assert.equal((await r.reconcile()).confirmed, true); assert.equal(r.uncertain, false); assert.equal(r.advanced.queue.length, 0);
});

test('invalid turn acknowledgement pauses an uncertain queue instead of dropping or resending it', async t => {
  const { runtime: r } = await fixture(t);
  r.advanced.paused = true; r.advanced.enqueue('Queued work', 'request-fixture-invalid');
  const rpc = r.rpc.bind(r); let starts = 0;
  r.rpc = (method, params) => method === 'turn/start' ? (starts++, Promise.resolve({ turn: { status: 'inProgress' } })) : rpc(method, params);
  r.advanced.pause(false); await until(() => r.uncertain);
  assert.equal(r.advanced.queue[0].state, 'uncertain'); assert.equal(r.advanced.paused, true);
  await delay(5); assert.equal(starts, 1);
});

test('private queue and Plan intent survive Sessions restart paused without leaking into its public index', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-queue-restart-')), hub = path.join(root, 'hub'), state = path.join(root, 'state');
  await mkdir(hub); const sqliteHome = path.join(root, 'sqlite'); await mkdir(sqliteHome);
  const transport = graphicalFixture({ approval: true });
  const open = async () => {
    const sessions = await new Sessions(hub, state).init();
    sessions.accountContext = async session => ({ label: 'Synthetic', conversationStoreId: 'fixture', sqliteHome, env: process.env, profileId: session.accountProfileId });
    sessions.permissionReady = session => session.graphical?.ready() === true;
    sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
    return sessions;
  };
  const original = await open(); t.after(() => original.closed ? undefined : original.close());
  const chat = await original.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'fixture', cwd: hub });
  const r = original.get(chat.id).graphical; await r.advanced.selectMode('plan');
  const notify = (method, params) => r.message({ method, params: { threadId: r.threadId, ...params } });
  notify('turn/started', { turn: { id: 'busy', status: 'inProgress' } });
  r.advanced.enqueue('Private queued request', 'request-restart-0001');
  notify('turn/completed', { turn: { id: 'busy', status: 'failed' } });
  await until(() => r.advanced.paused);
  const model = r.model;
  r.model = 'changed-model';
  r.advanced.pause(false);
  await until(() => r.advanced.paused);
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
  r.model = model;
  await assert.rejects(r.advanced.selectMode('default'), /clear the queue/);
  const empty = await original.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'fixture', cwd: hub });
  await original.close();
  assert.doesNotMatch(await readFile(path.join(state, 'sessions.json'), 'utf8'), /Private queued request|request-restart/);
  const restored = await open(); t.after(() => restored.close()); await restored.resume(chat.id);
  const next = restored.get(chat.id).graphical;
  assert.equal(next.threadId, chat.nativeId);
  await restored.resume(empty.id);
  assert.notEqual(restored.get(empty.id).graphical.threadId, empty.nativeId); assert.equal(next.advanced.modeIntent, 'plan');
  assert.equal(next.advanced.queue.length, 1); assert.equal(next.advanced.paused, true);
  assert.doesNotMatch(JSON.stringify(restored.list()), /Private queued request|request-restart/);
  await delay(5); assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
  next.advanced.pause(false); await until(() => !next.advanced.queue.length);
  const starts = transport.calls.filter(call => call.method === 'turn/start'); assert.equal(starts.length, 1);
  assert.equal(starts[0].params.collaborationMode.mode, 'plan');
});
