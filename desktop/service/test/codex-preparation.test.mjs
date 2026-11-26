import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexPreparation } from '../codex-preparation.mjs';
import { CodexWorkerPool } from '../codex-worker-pool.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';

async function ready(preparation) {
  for (let i = 0; i < 100 && !['ready', 'failed', 'skipped'].includes(preparation.status); i++) await new Promise(resolve => setTimeout(resolve, 2));
  await preparation.running;
}
function fixture(t, overrides = {}, wireOptions = {}) {
  const pool = new CodexWorkerPool({ maxIdle: 2 }), wire = pooledCodexFixture(wireOptions);
  const preparation = new CodexPreparation({ pool, resolve: async input => ({ ...input }), verify: async () => {}, launch: async input => ({ key: input.key, file: 'fixture', args: [], cwd: '.', env: {}, spawnChild: wire.spawnChild, profileId: input.key, kind: 'preparation' }), ...overrides });
  t.after(async () => { await preparation.close(); await pool.close(); });
  return { pool, wire, preparation };
}

async function skillReadStarted(wire, after = 0) {
  for (let i = 0; i < 100 && !wire.calls.slice(after).some(call => call.method === 'skills/list'); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(wire.calls.slice(after).some(call => call.method === 'skills/list'));
}

async function promptly(task) {
  let timer;
  try { await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cancelled discovery still waits for the native reply')), 300); })]); }
  finally { clearTimeout(timer); }
}

test('cancelling held skill discovery settles promptly without cancelling the adopted chat or its own request', async t => {
  const { preparation, pool, wire } = fixture(t, {}, { holdMethods: ['skills/list'] });
  preparation.request({ key: 'A' }, { delay: 0 }); await skillReadStarted(wire);
  const real = pool.acquire('A', { kind: 'chat' });
  pool.configure({ maxIdle: 0 });
  // A second held skills read belongs to the chat, not background preparation.
  const owner = {}, chatRead = real.transport.rpc('skills/list', { cwds: ['chat-scope'] }, 5000, owner);
  let cancelled;
  try {
    await real.transport.initialize();
    const result = await real.transport.rpc('thread/start', { cwd: '.' });
    assert.ok(result.thread.id);
    assert.equal(preparation.status, 'preparing');
    assert.ok(wire.children[0].heldReplies.has('skills/list'));
    cancelled = preparation.cancel();
    await promptly(cancelled);
    assert.equal(preparation.status, 'cancelled');
    assert.equal(real.transport.closed, false);
    assert.equal(real.transport.pending.size, 1);
    assert.equal([...real.transport.pending.values()][0].owner, owner);
    wire.children[0].releaseReplies('skills/list');
    assert.equal((await chatRead).data[0].cwd, 'chat-scope');
  } finally { wire.children[0].releaseReplies('skills/list'); await chatRead; await cancelled; await real.release(async () => {}); }
});

test('an adopted old engine with held discovery cannot delay preparation of a different account', async t => {
  const { preparation, pool, wire } = fixture(t, {}, { holdMethods: ['skills/list'] });
  preparation.request({ key: 'A' }, { delay: 0 }); await skillReadStarted(wire);
  const real = pool.acquire('A', { kind: 'chat' });
  let stopWaiting = false;
  try {
    preparation.request({ key: 'B' }, { delay: 0 });
    await promptly((async () => {
      while (!stopWaiting && wire.children.length < 2) await new Promise(resolve => setTimeout(resolve, 2));
    })());
    for (let i = 0; i < 100 && !wire.children[1].heldReplies.has('skills/list'); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(wire.children[1].heldReplies.has('skills/list'));
    preparation.request({ key: 'C' }, { delay: 0 });
    await promptly((async () => {
      while (!stopWaiting && wire.children.length < 3) await new Promise(resolve => setTimeout(resolve, 2));
    })());
    wire.children[2].releaseReplies('skills/list'); await ready(preparation);
    assert.equal(preparation.status, 'ready'); assert.equal(real.transport.closed, false);
    assert.equal(wire.children[1].closed, true);
    assert.equal(preparation.signature, JSON.stringify({ key: 'C' }));
  } finally {
    stopWaiting = true;
    // Late replies from A must be harmless even after B has become ready.
    for (const child of wire.children) child.releaseReplies('skills/list');
    await real.release(async () => {});
  }
});

test('a configuration revision during skill discovery cannot publish stale readiness', async t => {
  let key = 'A', fail = false;
  const { preparation, pool, wire } = fixture(t, { resolve: async () => ({ key }), verify: async () => { if (fail) throw new Error('identity changed'); } }, { holdMethods: ['skills/list'] });
  preparation.request({ key: 'A' }, { delay: 0 }); await skillReadStarted(wire);
  key = 'B'; wire.children[0].releaseReplies('skills/list'); await ready(preparation);
  assert.equal(preparation.status, 'skipped'); assert.equal(pool.retained.size, 0);
  fail = true; preparation.request({ key: 'B' }, { delay: 0 }); await ready(preparation);
  assert.equal(preparation.status, 'failed'); assert.equal(pool.retained.size, 0);
  const callsBeforeRetry = wire.calls.length;
  fail = false; preparation.request({ key: 'B' }, { delay: 0 });
  await skillReadStarted(wire, callsBeforeRetry);
  assert.equal(wire.children.length, 3);
  wire.children[2].releaseReplies('skills/list');
  await ready(preparation);
  assert.equal(preparation.status, 'ready');
  assert.equal(pool.retained.size, 1);
});
