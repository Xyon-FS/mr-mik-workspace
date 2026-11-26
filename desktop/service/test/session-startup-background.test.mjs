import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { Sessions } from '../sessions.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { mkdtemp } from './fixtures.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-background-start-'));
  const sessions = await new Sessions(root, root).init(), transport = graphicalFixture();
  sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  t.after(() => sessions.close());
  return { root, sessions, transport, options: { agent: 'codex', accountProfileId: 'fixture', chatInterface: 'chat', cwd: root, background: true } };
}

test('restore starts the selected graphical chat first and follows selection changes among pending tabs', async t => {
  const { sessions, options } = await fixture(t), started = deferred(), release = deferred();
  for (const [id, agent, chatInterface] of [['older', 'codex', 'chat'], ['terminal', 'codex', 'cli'], ['closed', 'codex', 'chat'], ['newer', 'codex', 'chat'], ['claude', 'claude', 'chat']]) {
    sessions.items.set(id, sessions.make({ ...options, id, name: id, agent, chatInterface, status: 'stopped', open: true }));
  }
  let selected = 'claude';
  const order = [], timings = [];
  sessions.resume = async id => {
    order.push(id);
    if (id === 'claude') { started.resolve(); await release.promise; }
    sessions.get(id).status = 'running';
  };
  const restoring = sessions.restore(() => selected, (phase, details) => timings.push({ phase, ...details }));
  try {
    assert.deepEqual(order, ['claude']);
    await started.promise;
    sessions.get('closed').open = false;
    selected = 'newer';
  } finally { release.resolve(); await restoring; }
  assert.deepEqual(order, ['claude', 'newer', 'older', 'terminal']);
  assert.deepEqual(timings.map(({ phase, selected }) => [phase, selected]), [
    ['restore-start', undefined], ['tab-restore-finished', true], ['tab-restore-finished', true], ['tab-restore-finished', false], ['tab-restore-finished', false],
  ]);
  assert.ok(timings.slice(1).every(sample => sample.queueMs >= 0 && sample.durationMs >= 0 && sample.status === 'running'));
});
test('background registration is durable before native startup and duplicate resume does not start a second worker', async t => {
  const { root, sessions, transport, options } = await fixture(t), gate = deferred(), entered = deferred();
  sessions.prepareLaunch = async () => { entered.resolve(); await gate.promise; return null; };
  try {
    const created = await sessions.create(options), item = sessions.get(created.id);
    assert.equal(created.status, 'starting');
    assert.equal(JSON.parse(await readFile(path.join(root, 'sessions.json')))[0].id, created.id);
    await entered.promise; assert.equal(transport.children.length, 0);
    await assert.rejects(sessions.setAccountProfile(created.id, 'another'), /finish starting/);
    await assert.rejects(sessions.setInterface(created.id, 'cli'), /finish starting/);
    await assert.rejects(sessions.setCodexPermissions(created.id, 'ask'), /finish starting/);
    const resumed = sessions.resume(created.id), startup = item.startupPromise; gate.resolve(); await startup; await resumed;
    assert.equal(item.status, 'running'); assert.equal(transport.children.length, 1);
    assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
  } finally { gate.resolve(); }
  sessions.verifyAccount = async () => { throw new Error('Synthetic account unavailable'); };
  const failedChat = await sessions.create(options), failedItem = sessions.get(failedChat.id); await failedItem.startupPromise;
  assert.equal(failedItem.status, 'stopped'); assert.match(failedItem.restoreError, /account unavailable/);
  assert.equal(failedItem.accountProfileId, 'fixture'); assert.equal(transport.children.length, 1);
  sessions.verifyAccount = async () => {}; await sessions.resume(failedChat.id);
  assert.equal(failedItem.status, 'running'); assert.equal(transport.children.length, 2);
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});
test('service shutdown waits for its own preparation and does not launch a late worker', async t => {
  const { sessions, transport, options } = await fixture(t), gate = deferred(), entered = deferred();
  sessions.prepareLaunch = async () => { entered.resolve(); await gate.promise; return null; };
  try {
    await sessions.create(options); await entered.promise;
    const closing = sessions.close(); gate.resolve(); await closing;
    assert.equal(transport.children.length, 0);
  } finally { gate.resolve(); }
});

test('registration write failure rolls back its durable row and never launches a worker', async t => {
  const { root, sessions, transport, options } = await fixture(t), persist = sessions.persist.bind(sessions);
  let first = true;
  sessions.persist = async () => { await persist(); if (first) { first = false; throw new Error('Synthetic initial write failure'); } };
  await assert.rejects(sessions.create(options), /initial write failure/);
  assert.deepEqual(sessions.list(), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'sessions.json'))), []);
  assert.equal(transport.children.length, 0);
});
