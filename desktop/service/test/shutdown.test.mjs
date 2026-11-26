import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { stopService, SERVICE_SHUTDOWN_MS } from '../shutdown.mjs';
import { leaseConversation } from '../conversation-lease.mjs';
import { Sessions } from '../sessions.mjs';
import { mkdtemp, createService } from './fixtures.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function beforeDeadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic writer did not finish shutdown.')), 10000); })]); }
  finally { clearTimeout(timer); }
}

test('shutdown shares quit requests and lets cleanup outlast the old eight-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hold = deferred(), codes = []; let closes = 0;
  const stop = stopService({ close() { closes++; return hold.promise; } }, { exit: code => codes.push(code) });
  const closing = stop(); assert.equal(stop(), closing);
  await Promise.resolve(); t.mock.timers.tick(8001);
  assert.deepEqual(codes, []); assert.equal(closes, 1);
  hold.resolve(); await closing;
  assert.deepEqual(codes, [0]); t.mock.timers.tick(SERVICE_SHUTDOWN_MS); assert.deepEqual(codes, [0]);
});

test('shutdown failure and final deadline report a single unsuccessful exit without unhandled rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const codes = []; let reports = 0;
  const failed = stopService({ close() { throw new Error('private diagnostic'); } }, { exit: code => codes.push(code), report: () => reports++ });
  await failed(); assert.deepEqual(codes, [1]); assert.equal(reports, 1);
  const hold = deferred();
  const slow = stopService({ close: () => hold.promise }, { exit: code => codes.push(code), report: () => reports++, timeoutMs: 20 });
  const closing = slow(); await Promise.resolve(); t.mock.timers.tick(20);
  assert.deepEqual(codes, [1, 1]); hold.resolve(); await closing;
  assert.deepEqual(codes, [1, 1]); assert.equal(reports, 2);
});

async function addSyntheticWriter(sessions, profile) {
  const id = randomUUID(), nativeId = randomUUID();
  const release = await leaseConversation(profile, nativeId);
  const session = sessions.make({ id, agent: 'claude', chatInterface: 'chat', nativeId, cwd: sessions.repo, name: 'Synthetic shutdown', open: true });
  const hold = deferred(), stopped = deferred(); let closed = false;
  session.graphical = session.process = { close: async () => {
    if (closed) return; closed = true;
    await hold.promise;
    session.process = null; session.leaseReleasing = release(); await session.leaseReleasing;
    stopped.resolve();
  } };
  sessions.items.set(id, session);
  return { session, nativeId, hold, stopped };
}

test('a failed pooled worker does not strand independent Claude writers, their leases or history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shutdown-sessions-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  const profile = { sqliteHome: path.join(root, 'native') }; await mkdir(profile.sqliteHome);
  const writer = await addSyntheticWriter(sessions, profile);
  const failure = new Error('Synthetic shared worker failure');
  sessions.codexWorkers.close = async () => { throw failure; };
  try {
    const closing = sessions.close(); assert.equal(sessions.close(), closing);
    const rejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(failure));
    await assert.rejects(leaseConversation(profile, writer.nativeId), /already owned/);
    writer.hold.resolve(); await rejected;
    const release = await leaseConversation(profile, writer.nativeId); await release();
    assert.equal(writer.session.process, null);
    const index = JSON.parse(await readFile(path.join(root, 'state', 'sessions.json'), 'utf8'));
    assert.ok(JSON.stringify(index).includes(writer.nativeId));
  } finally { writer.hold.resolve(); await sessions.close().catch(() => {}); }
});

test('an actual service closes native writers before a slow account cleanup, and joins concurrent closes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shutdown-service-'));
  const failure = new Error('Synthetic account cleanup failure');
  const factory = async options => {
    const service = await (await import('../server.mjs')).createService(options);
    service.rawShutdown = service.close.bind(service);
    // The real shutdown error is asserted below; the fixture teardown may then
    // acknowledge this exact injected failure after all resources were drained.
    service.close = async () => {
      try { await service.rawShutdown(); }
      catch (error) { assert.ok(error instanceof AggregateError && error.errors.includes(failure)); }
    };
    return service;
  };
  const service = await createService({ repo: root, uiDir: root, mcpOptions: { home: path.join(root, 'home'), env: {} } }, factory);
  const profile = { sqliteHome: path.join(root, 'native') }; await mkdir(profile.sqliteHome);
  const writer = await addSyntheticWriter(service.sessions, profile), accountHold = deferred();
  const accountClose = service.accounts.close.bind(service.accounts);
  service.accounts.close = async () => { await accountHold.promise; await accountClose(); throw failure; };
  try {
    let settled = false;
    const closing = service.rawShutdown();
    const expectCleanupFailure = promise => assert.rejects(promise, error => error instanceof AggregateError && error.errors.includes(failure));
    const rejected = expectCleanupFailure(closing).finally(() => { settled = true; });
    writer.hold.resolve();
    // Wait for a definite native exit/lease release, not an arbitrary delay.
    await beforeDeadline(writer.stopped.promise);
    assert.equal(settled, false);
    const release = await leaseConversation(profile, writer.nativeId); await release();
    const response = await fetch(service.origin + '/api/bootstrap', { headers: { Authorization: `Bearer ${service.token}` } });
    assert.equal(response.status, 503);
    const concurrent = expectCleanupFailure(service.rawShutdown());
    accountHold.resolve(); await Promise.all([rejected, concurrent]);
    await assert.rejects(fetch(service.origin + '/api/bootstrap'));
  } finally { writer.hold.resolve(); accountHold.resolve(); await service.close(); }
});
