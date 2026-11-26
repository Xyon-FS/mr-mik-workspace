import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { CodexChat } from '../codex-chat.mjs';
import { CodexWorkerPool } from '../codex-worker-pool.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';
import { mkdtemp } from './fixtures.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-codex-pool-')), home = path.join(root, 'home'); await mkdir(home);
  const pool = new CodexWorkerPool(options), wire = pooledCodexFixture(), runtimes = [];
  const account = { profileId: 'fixture-account', privateHome: home, configRevision: 'fixture-config', conversationStoreId: 'fixture-store' };
  const create = options => {
    const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'medium', ...options?.session }, env: { CODEX_HOME: home, ...options?.env }, stateDir: root, workerPool: pool, account: { ...account, ...options?.account }, spawnChild: wire.spawnChild, bridge: options?.bridge, browser: options?.browser });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => { for (const child of wire.children) { child.ignoreInterrupt = false; child.rejectDetach = false; } await pool.close(); await Promise.all(runtimes.map(runtime => runtime.close())); });
  return { root, home, pool, wire, account, create };
}

for (const [name,change] of [
  ['saved conversation', r => { r.session.hasConversation = true; }],
  ['uncertain submission', r => { r.uncertain = true; }],
  ['in-flight submission', r => { r.submitting = true; }],
]) test(`close still checks native state for ${name}`, async t => {
  const { create, wire } = await fixture(t, { maxIdle: 1 }), runtime = create({ session: { hasConversation: false } });
  await runtime.start(); change(runtime); const at = wire.calls.length;
  await runtime.close(); assert.ok(wire.calls.slice(at).some(call => call.method === 'thread/read'));
});

test('unknown native thread status retains the attachment instead of treating it as a quota failure', async t => {
  const { create, wire } = await fixture(t, { maxIdle: 1 }), a = create(), b = create();
  await a.start(); await b.start(); wire.threads.get(a.threadId).status = { type: 'unknown' };
  await assert.rejects(a.close(), /lease is retained/); assert.equal(a.closed, false); assert.equal(b.closed, false);
  assert.equal(wire.calls.some(call => call.method === 'thread/unsubscribe'), false);
});

test('Steer, Stop, approvals and active close target only their owning chat', async t => {
  const { create, wire } = await fixture(t), a = create(), b = create(); await Promise.all([a.start(), b.start()]);
  await Promise.all([a.submit('A'), b.submit('B')]);
  const bTurn = b.turnId, approval = wire.children[0].approve(b.threadId);
  await a.advanced.steer('A guidance', a.turnId); await a.close();
  assert.equal(a.closed, true); assert.equal(b.closed, false); assert.equal(b.turnId, bTurn); assert.equal(b.requests.size, 1);
  assert.equal(wire.threads.get(a.threadId).unsubscribed, true);
  assert.equal(wire.calls.filter(call => call.method === 'turn/interrupt' && call.params.threadId === b.threadId).length, 0);
  const reopened = create(); await reopened.start(a.threadId);
  assert.equal(reopened.transport, b.transport); assert.equal(reopened.threadId, a.threadId);
  assert.equal(wire.children.length, 1);
  const closing = reopened.close();
  await assert.rejects(reopened.rpc('thread/settings/update', { threadId: reopened.threadId, model: 'changed' }), /closing/);
  await closing;
  assert.equal(b.closed, false); assert.equal(b.turnId, bTurn); assert.equal(b.requests.size, 1);
  b.answer(String(approval), 'decline'); assert.equal(b.requests.size, 0);
  await b.interrupt(); assert.equal(b.snapshot().working, false);
});

test('foreign root writes/reads and child writes are rejected before native dispatch', async t => {
  const { create, wire } = await fixture(t), a = create(), b = create(); await Promise.all([a.start(), b.start()]);
  for (const method of ['thread/read', 'thread/settings/update', 'turn/start', 'turn/interrupt']) await assert.rejects(a.rpc(method, { threadId: b.threadId }), /does not belong/);
  a.upsert({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } });
  await assert.rejects(a.rpc('turn/start', { threadId: 'child' }), /does not belong/);
  await assert.rejects(a.rpc('skills/list', { cwds: [b.session.cwd, 'foreign'] }), /does not belong/);
  await assert.rejects(a.rpc('config/read', { cwd: 'foreign' }), /working directory/);
  assert.equal(wire.calls.filter(call => ['turn/start', 'turn/interrupt', 'thread/settings/update'].includes(call.method)).length, 0);
});

test('different account, permissions, environment, directory or native configuration use distinct workers', async t => {
  const { create, wire, root, home } = await fixture(t), a = create(); await a.start();
  const others = [create({ account: { profileId: 'other-account' } }), create({ session: { codexPermissions: 'bypass' } }), create({ env: { FIXTURE_OPTION: 'different' } })];
  const folder = path.join(root, 'other'); await mkdir(folder); others.push(create({ session: { cwd: folder } }));
  await Promise.all(others.map(runtime => runtime.start()));
  await writeFile(path.join(home, 'config.toml'), '# changed fixture config'); const changed = create(); await changed.start();
  assert.equal(wire.children.length, 6); assert.notEqual(changed.transport, a.transport);
});

test('Bridge/browser credentials stay in separate private descriptors, never common environment or native config', async t => {
  const { create, wire, root } = await fixture(t);
  const bridge = token => ({ script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)), url: 'http://127.0.0.1:12345/bridge', token, instructions: `scope ${token.slice(-1)}` });
  const a = create({ bridge: bridge('synthetic-A'), env: { MRMAK_BRIDGE_TOKEN: 'synthetic-A' } }), b = create({ bridge: bridge('synthetic-B'), env: { MRMAK_BRIDGE_TOKEN: 'synthetic-B' } });
  await Promise.all([a.start(), b.start()]);
  assert.equal(a.transport, b.transport); assert.equal(wire.children[0].options.env.MRMAK_BRIDGE_TOKEN, undefined);
  const configA = wire.threads.get(a.threadId).params.config, configB = wire.threads.get(b.threadId).params.config;
  assert.doesNotMatch(JSON.stringify([configA, configB, wire.children[0].args]), /synthetic-[AB]/);
  const fileA = configA['mcp_servers.mrmak_workspace'].args[1], fileB = configB['mcp_servers.mrmak_workspace'].args[1];
  assert.notEqual(fileA, fileB); assert.equal(JSON.parse(await readFile(fileA)).env.MRMAK_BRIDGE_TOKEN, 'synthetic-A');
  await a.close(); await assert.rejects(readFile(fileA), { code: 'ENOENT' }); assert.equal(JSON.parse(await readFile(fileB)).env.MRMAK_BRIDGE_TOKEN, 'synthetic-B');
  await b.close(); assert.deepEqual(await readdir(path.join(root, 'codex-thread-mcp')), []);
});

test('failed detach retains its owner and sibling; failed worker is quarantined without replay', async t => {
  const { create, wire, pool } = await fixture(t), a = create(), b = create(); await Promise.all([a.start(), b.start()]);
  wire.children[0].rejectDetach = true;
  await assert.rejects(a.close(), /did not confirm/); assert.equal(a.closed, false); assert.equal(b.closed, false); assert.equal(pool.workers.size, 0);
  wire.children[0].rejectDetach = false; const c = create(); await c.start();
  assert.notEqual(c.transport, b.transport); assert.equal(wire.children.length, 2);
  await a.close(); assert.equal(b.closed, false); assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('actual shared worker death marks every attachment disconnected and starts no replacement turn', async t => {
  const { create, wire } = await fixture(t), a = create(), b = create(); await Promise.all([a.start(), b.start()]);
  await Promise.all([a.submit('A'), b.submit('B')]);
  wire.children[0].kill(); assert.equal(a.closed, true); assert.equal(b.closed, true);
  assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 2); assert.equal(wire.children.length, 1);
  await Promise.all([a.close(), b.close()]);
});

test('unconfirmed startup cannot kill a sibling and is drained when the last usable attachment leaves', async t => {
  const { create, wire, pool } = await fixture(t), a = create(); await a.start();
  wire.children[0].holdStarts = true; const b = create(), rpc = b.rpc.bind(b);
  b.rpc = (method, params, timeout) => rpc(method, params, method === 'thread/start' ? 10 : timeout);
  await assert.rejects(b.start(), error => error.uncertain === true);
  await assert.rejects(b.close(), /unconfirmed/);
  assert.equal(a.closed, false); assert.equal(b.closed, false); assert.equal(pool.workers.size, 0);
  await a.close(); assert.equal(a.closed, true); assert.equal(b.closed, true); assert.equal(pool.retained.size, 0);
  assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('verified pooled root identity is recorded before optional discovery and failures cannot trigger replay', async t => {
  const { create, wire } = await fixture(t), a = create(); let recorded = null;
  a.recordNativeRoot = async id => { recorded = id; assert.equal(wire.calls.some(call => call.method === 'collaborationMode/list'), false); };
  await a.start(); assert.equal(recorded, a.threadId);
  const b = create(); b.recordNativeRoot = async () => { throw new Error('Synthetic identity persistence failure'); };
  await assert.rejects(b.start(), /identity persistence/); await b.close();
  assert.equal(a.closed, false); assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('expiry cannot terminate an adopted engine and later closes a truly idle one', async t => {
  const { create, pool } = await fixture(t, { maxIdle: 2, idleTtlMs: 15 });
  const a = create(); await a.start(); t.mock.timers.enable({ apis: ['setTimeout'] }); await a.close();
  const b = create(); await b.start(); t.mock.timers.tick(35);
  assert.equal(b.transport, a.transport); assert.equal(b.closed, false);
  await b.close(); t.mock.timers.tick(35); await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.transport.closed, true); assert.equal(pool.retained.size, 0);
});

test('account invalidation drains idle workers but never kills another active root', async t => {
  const { create, pool } = await fixture(t, { maxIdle: 2 });
  const a = create(), b = create({ account: { profileId: 'B' } }); await a.start(); await b.start();
  await b.close(); await a.submit('active original'); const turn = a.turnId;
  await pool.invalidate('B'); assert.equal(b.transport.closed, true); assert.equal(a.turnId, turn);
  await pool.invalidate('fixture-account'); assert.equal(a.closed, false); assert.equal(a.turnId, turn);
  const replacement = create(); await replacement.start(); assert.notEqual(replacement.transport, a.transport);
  await a.interrupt(); await a.close(); assert.equal(a.transport.closed, true);
});

test('LRU trimming rechecks ownership when another idle engine is adopted during an awaited exit', async t => {
  const { create, pool } = await fixture(t, { maxIdle: 3 });
  const a = create(), b = create({ account: { profileId: 'B' } }), c = create({ account: { profileId: 'C' } });
  for (const runtime of [a, b, c]) { await runtime.start(); await runtime.close(); }
  let finishExit; const gate = new Promise(resolve => { finishExit = resolve; }), originalClose = a.transport.close.bind(a.transport);
  a.transport.close = async () => { await gate; return originalClose(); };
  pool.configure({ maxIdle: 0 }); const trimming = pool.trim();
  try {
    await new Promise(resolve => setImmediate(resolve));
    const adopted = create({ account: { profileId: 'B' } }); await adopted.start();
    assert.equal(adopted.transport, b.transport);
    finishExit(); await trimming;
    assert.equal(adopted.closed, false); assert.equal(adopted.transport.closed, false); assert.equal(c.transport.closed, true);
  } finally { finishExit(); await trimming; }
});

test('a new answered conversation is materialized before unsubscribe and cross-process handoff', async t => {
  const { create, wire } = await fixture(t, { maxIdle: 2 }); const runtime = create(); await runtime.start();
  await runtime.submit('Synthetic first turn'); await runtime.interrupt();
  const start = wire.calls.length; await runtime.close();
  const closeCalls = wire.calls.slice(start), flush = closeCalls.findIndex(c => c.method === 'thread/read' && c.params.includeTurns === true), unsubscribe = closeCalls.findIndex(c => c.method === 'thread/unsubscribe');
  assert.ok(flush >= 0 && flush < unsubscribe, 'lazy first history must be materialized while its live writer still exists');
});

test('a slow closing root keeps its lease while a distinct root reuses the healthy worker', async t => {
  const { create, wire, pool } = await fixture(t, { maxIdle: 2 }), a = create({ session: { hasConversation: false } }); await a.start();
  const transport = a.transport, child = wire.children[0]; child.deferUnload = a.threadId;
  const closing = a.close();
  try {
    // Reproduce native shutdown exceeding the former 2.5-second unload budget.
    await new Promise(resolve => setTimeout(resolve, 2700));
    assert.equal(a.closed, false); assert.equal(transport.closed, false);
    assert.ok(child.args.includes('thread_unload_delay_secs=0'));
    assert.equal([...pool.retained][0].users.size, 1);
    assert.equal(pool.workers.size, 1);
    assert.equal(wire.calls.some(call => call.method === 'thread/read' && call.params.threadId === a.threadId), false);
    const b = create(); await b.start();
    assert.equal(b.transport, transport); assert.notEqual(b.threadId, a.threadId);
    await b.submit('Synthetic sibling');
    const turnId = b.turnId;
    assert.equal([...pool.retained][0].users.size, 2);
    child.deferUnload = null; child.notify('thread/closed', { threadId: a.threadId });
    await closing;
    assert.equal(a.closed, true); assert.equal(b.closed, false);
    assert.equal(b.turnId, turnId); assert.equal(transport.closed, false);
    assert.equal([...pool.retained][0].users.size, 1);
    assert.equal(wire.children.length, 1);
    assert.equal(wire.calls.filter(c => c.method === 'thread/unsubscribe' && c.params.threadId === a.threadId).length, 1);
  } finally { child.deferUnload = null; await closing; }
});

test('unload deadline failure retains a sibling and quarantines instead of terminating its worker', async t => {
  const { create, wire, pool } = await fixture(t, { maxIdle: 2 }), a = create(), b = create();
  await Promise.all([a.start(), b.start()]);
  a.unloadTimeoutMs = 30; wire.children[0].deferUnload = a.threadId;
  await assert.rejects(a.close(), { code: 'CODEX_UNLOAD_PENDING' });
  assert.equal(b.closed, false); assert.equal(a.transport.closed, false);
  assert.equal(pool.workers.size, 0); assert.equal([...pool.retained][0].users.size, 2);
  wire.children[0].deferUnload = null; await a.close();
});

test('duplicate lease release shares cleanup and bounds pending owners without killing them', async t => {
  const { pool, wire, root } = await fixture(t, { maxIdle: 2 });
  const options = { file: 'fixture', args: [], cwd: root, env: {}, spawnChild: wire.spawnChild };
  const leases = Array.from({ length: 8 }, () => pool.acquire('bounded-closing', options));
  let finish; const gate = new Promise(resolve => { finish = resolve; }); let calls = 0;
  const close = () => { calls++; return gate; };
  const releases = leases.map(lease => lease.release(close));
  try {
    assert.equal(leases[0].release(close), releases[0]); assert.equal(calls, 8);
    assert.throws(() => pool.acquire('another', options), /still closing/);
    assert.equal(wire.children[0].closed, undefined);
  } finally { finish(); await Promise.all(releases); }
  const adopted = pool.acquire('bounded-closing', options); await adopted.release(async () => {});
  assert.equal(wire.children.length, 1);
});

test('an expired sole-owner unload closes the process instead of caching an unfinished root', async t => {
  const { create, wire, pool } = await fixture(t, { maxIdle: 2 }), runtime = create(); await runtime.start();
  runtime.unloadTimeoutMs = 30; wire.children[0].deferUnload = runtime.threadId;
  await runtime.close();
  assert.equal(runtime.closed, true); assert.equal(runtime.transport.closed, true);
  assert.equal(pool.workers.size, 0); assert.equal(pool.retained.size, 0);
});

test('active paginated roots and children close without full history and preserve sibling approvals', async t => {
  const { create, wire, root } = await fixture(t, { maxIdle: 2 }), a = create(), b = create();
  await Promise.all([a.start(), b.start()]); await Promise.all([a.submit('Owned active root'), b.submit('Sibling active root')]);
  const childId = 'owned-active-child', childTurn = 'owned-child-turn', saved = path.join(root, 'synthetic-transcript.jsonl');
  await writeFile(saved, '{}\n');
  Object.assign(wire.threads.get(a.threadId), { historyMode: 'paginated', path: saved });
  wire.threads.set(childId, { id: childId, historyMode: 'paginated', status: { type: 'active' }, turns: [{ id: childTurn, status: 'inProgress' }] });
  a.upsert({ id: 'spawn-active', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [childId] });
  wire.children[0].approve(a.threadId); assert.equal(a.requests.size, 1);
  const siblingTurn = b.turnId, approval = wire.children[0].approve(b.threadId), offset = wire.calls.length;
  wire.children[0].rejectFullHistory = true;
  await a.close();
  const closing = wire.calls.slice(offset);
  assert.equal(closing.some(c => c.method === 'thread/read' && c.params.includeTurns), false);
  assert.deepEqual(closing.filter(c => c.method === 'turn/interrupt').map(c => c.params.threadId), [childId, a.threadId]);
  assert.deepEqual(closing.filter(c => c.method === 'thread/unsubscribe').map(c => c.params.threadId), [childId, a.threadId]);
  assert.equal(a.closed, true); assert.equal(a.requests.size, 0); assert.equal(b.closed, false); assert.equal(b.turnId, siblingTurn); assert.equal(b.requests.size, 1);
  b.answer(String(approval), 'decline'); wire.children[0].rejectFullHistory = false;
});

for (const method of ['collaborationMode/list', 'windowsSandbox/readiness']) test(`closing during ${method} cancels only that owner without waiting for its held reply`, async t => {
  const { create, wire } = await fixture(t, { maxIdle: 2 }), a = create(); await a.start();
  const child = wire.children[0]; child.holdMethods.add(method);
  const b = create(), starting = b.start();
  try {
    for (let i = 0; i < 200 && !child.heldReplies.has(method); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(child.heldReplies.has(method)); assert.equal(b.snapshot().connected, false);
    await b.close(); await starting;
    assert.equal(b.closed, true); assert.equal(a.closed, false); assert.equal(a.transport.closed, false);
    assert.equal(a.transport.pending.size, 0);
    assert.equal((await a.rpc('thread/read', { threadId: a.threadId, includeTurns: false })).thread.id, a.threadId);
  } finally { child.releaseReplies(method); await starting; }
});

test('failed capability startup stays unavailable and closes without interrupting a sibling turn or approval', async t => {
  const { create, wire } = await fixture(t, { maxIdle: 2 }), a = create(); await a.start(); await a.submit('Synthetic active sibling');
  const turnId = a.turnId, approval = wire.children[0].approve(a.threadId), b = create();
  b.advanced.discover = async () => { throw new Error('Synthetic capability failure'); };
  await assert.rejects(b.start(), /Synthetic capability failure/);
  assert.equal(b.snapshot().connected, false); assert.equal(b.idle(), false);
  await assert.rejects(b.submit('Blocked after setup failure'), /Finish the current request/);
  assert.throws(() => b.advanced.enqueue('Blocked queue', 'setup-failure-queue-001'), /Resolve the current connection/);
  assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 1);
  await b.close(); assert.equal(b.closed, true);
  assert.equal(a.closed, false); assert.equal(a.turnId, turnId); assert.equal(a.requests.size, 1);
  assert.equal(wire.calls.some(call => call.method === 'turn/interrupt' && call.params.threadId === a.threadId), false);
  a.answer(String(approval), 'decline');
});
