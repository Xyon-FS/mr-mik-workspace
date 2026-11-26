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

test('closing retained legacy History while its screen hydrates must keep it closed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-legacy-history-cancel-'));
  const sessions = await new Sessions(root, root).init();
  const saved = await sessions.importConversation({ agent: 'kimi', nativeId: 'retained-native-id', name: 'Retained legacy history', cwd: root });
  const hydration = sessions.hydrate.bind(sessions), gate = deferred(), entered = deferred();
  sessions.hydrate = async session => { entered.resolve(); await gate.promise; await hydration(session); };
  t.after(() => sessions.close());
  const opening = sessions.resume(saved.id); let closing;
  try {
    await entered.promise; closing = sessions.remove(saved.id);
    gate.resolve(); await Promise.all([opening, closing]);
    assert.equal(sessions.get(saved.id).open, false);
    assert.equal(sessions.get(saved.id).process, null);
    assert.equal(JSON.parse(await readFile(path.join(root, 'sessions.json'), 'utf8'))[0].open, false);
  } finally { gate.resolve(); await opening; await closing; }
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-resume-race-'));
  const sessions = await new Sessions(root, root).init(), wire = graphicalFixture(), runtimes = [];
  sessions.createGraphicalRuntime = options => {
    const runtime = new CodexChat({ ...options, spawnChild: wire.spawnChild }); runtimes.push(runtime); return runtime;
  };
  t.after(async () => { await sessions.close(); await Promise.all(runtimes.map(runtime => runtime.close())); });
  const created = await sessions.create({ agent: 'codex', accountProfileId: 'fixture', chatInterface: 'chat', cwd: root });
  await sessions.remove(created.id);
  const gate = deferred(), entered = deferred();
  sessions.resolveLocation = async () => { entered.resolve(); await gate.promise; return root; };
  t.after(() => gate.resolve());
  return { root, sessions, wire, created, gate, entered };
}

test('overlapping History/reconnect resumes create exactly one native writer', async t => {
  const { sessions, wire, created, gate, entered } = await fixture(t);
  const before = wire.children.length;
  const first = sessions.resume(created.id), second = sessions.resume(created.id);
  const results = Promise.allSettled([first, second]);
  try {
    await entered.promise; await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(sessions.setAccountProfile(created.id, 'other'), /finish starting/);
    await assert.rejects(sessions.setInterface(created.id, 'cli'), /finish starting/);
    await assert.rejects(sessions.setWorkingProject(created.id, {}, {}), /Close this chat/);
    await assert.rejects(sessions.forget(created.id), /Close the chat/);
    await assert.rejects(sessions.archive(created.id, true), /Close the chat/);
    gate.resolve(); const settled = await results;
    assert.ok(settled.every(result => result.status === 'fulfilled'));
    assert.equal(wire.children.length - before, 1);
    assert.equal(sessions.get(created.id).process, sessions.get(created.id).graphical);
  } finally { gate.resolve(); await results; }
  const session = sessions.get(created.id), proc = session.process, count = wire.children.length;
  const closeProcess = sessions.closeProcess;
  sessions.closeProcess = async () => { throw new Error('Synthetic native close was not confirmed'); };
  try {
    await assert.rejects(sessions.remove(created.id), /not confirmed/);
    assert.equal(session.process, proc);
    await sessions.resume(created.id);
    assert.equal(session.open, true);
    assert.equal(session.process, proc); assert.equal(wire.children.length, count);
  } finally { sessions.closeProcess = closeProcess; }
});

test('closing a chat during History resume prevents a late writer and keeps the tab closed on disk', async t => {
  const { root, sessions, wire, created, gate, entered } = await fixture(t);
  const before = wire.children.length;
  const resuming = sessions.resume(created.id), settled = Promise.allSettled([resuming]);
  try {
    await entered.promise;
    const closing = sessions.remove(created.id);
    gate.resolve(); await Promise.all([settled, closing]);
    assert.equal(wire.children.length, before);
    assert.equal(sessions.get(created.id).open, false);
    assert.equal(JSON.parse(await readFile(path.join(root, 'sessions.json'), 'utf8'))[0].open, false);
  } finally { gate.resolve(); await settled; }
});

test('failed History removal preserves the in-memory row and its saved metadata', async t => {
  const { sessions, root, created, gate } = await fixture(t); gate.resolve();
  const session = sessions.get(created.id), persist = sessions.persist;
  sessions.persist = async () => { throw new Error('Synthetic History write failure'); };
  try {
    await assert.rejects(sessions.forget(created.id), /History write failure/);
    assert.equal(sessions.get(created.id), session);
    assert.ok(JSON.parse(await readFile(path.join(root, 'sessions.json'), 'utf8')).some(row => row.id === created.id));
  } finally { sessions.persist = persist; }
});

test('synchronous initial creation owns startup across close, reopen and account changes', async t => {
  const { sessions, wire, root, gate, entered } = await fixture(t);
  const before = wire.children.length;
  const creating = Promise.allSettled([sessions.create({ agent: 'codex', accountProfileId: 'fixture', chatInterface: 'chat', cwd: root, name: 'Initial startup race' })]);
  let closing, reopening;
  try {
    await entered.promise;
    const session = [...sessions.items.values()].find(value => value.name === 'Initial startup race');
    assert.ok(session.startupPromise, 'initial creation must register startup ownership before preflight');
    await assert.rejects(sessions.setAccountProfile(session.id, 'other'), /finish starting/);
    assert.equal(session.accountProfileId, 'fixture');
    closing = Promise.allSettled([sessions.remove(session.id)]);
    reopening = Promise.allSettled([sessions.resume(session.id)]);
    gate.resolve();
    await Promise.all([creating, closing, reopening]);
    assert.equal((await creating)[0].status, 'rejected');
    assert.equal((await closing)[0].status, 'fulfilled');
    assert.equal(session.open, false);
    assert.equal(session.process, null);
    assert.equal(wire.children.length, before, 'cancelled creation/reopen must not leave native writers');
    assert.equal(sessions.items.has(session.id), false, 'cancelled initial creation must not retain a half-created row');
  } finally { gate.resolve(); await creating; await closing; await reopening; }
});
