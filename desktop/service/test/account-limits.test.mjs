import assert from 'node:assert/strict';
import test from 'node:test';
import { accountLimits, AccountLimitsReader } from '../account-limits.mjs';

const sessions = (...items) => ({ items: new Map(items.map((item, index) => [index, item])) });
const codex = (profile, percent) => {
  let working = false;
  let reads = 0;
  const advanced = { limits: [{ label: 'Codex', primary: { usedPercent: percent, minutes: 300, resetsAt: 2000000000 } }] };
  return { agent: 'codex', chatInterface: 'chat', accountProfileId: profile, graphical: { snapshot: () => ({ connected: true, working, advanced }), advanced: { refreshLimits: async () => { reads++; } } }, reads: () => reads, busy: () => { working = true; } };
};
test('selected Codex profile refreshes when idle and exposes cached limits during a turn', async () => {
  const first = codex('one', 0), second = codex('two', 75);
  const result = await accountLimits(sessions(first, second), 'codex', 'two');
  assert.equal(result.windows[0].percent, 75);
  assert.equal(result.windows[0].resetsAt, '2033-05-18T03:33:20.000Z');
  assert.equal(first.reads(), 0); assert.equal(second.reads(), 1);
  assert.deepEqual((await accountLimits(sessions(first), 'codex', 'missing')).windows, []);
  assert.deepEqual((await accountLimits(sessions(first), 'codex', null)).windows, []);
  second.busy();
  const cached = await accountLimits(sessions(first, second), 'codex', 'two');
  assert.equal(cached.windows[0].percent, 75);
  assert.match(cached.note, /Last reported/);
  assert.equal(second.reads(), 1);
});

test('native reads are deduplicated, cached briefly and separated by profile and account identity', async () => {
  let count = 0, now = 1000, finish, identity = 'first', disconnected = false, failed = false;
  const reader = new AccountLimitsReader({ now: () => now, ttl: 30, context: async (_agent, profile) => {
    if (disconnected) throw new Error('PRIVATE_LOGIN');
    return { directory: profile, identityKey: identity };
  }, claude: async () => {
    if (failed) throw new Error('PRIVATE_PROVIDER_ERROR');
    count++; if (count === 1) await new Promise(resolve => { finish = resolve; }); return { windows: [{ label: 'native', percent: count }] }; } });
  const a = accountLimits(sessions(), 'claude', 'a', reader), b = reader.read('claude', 'a'); await new Promise(resolve => setImmediate(resolve)); finish();
  const selected = await a; assert.equal(selected.windows[0].percent, 1); assert.doesNotMatch(selected.note, /Open.*chat/); await b; assert.equal(count, 1);
  await reader.read('claude', 'a'); assert.equal(count, 1); await reader.read('claude', 'b'); assert.equal(count, 2);
  identity = 'new-account'; await reader.read('claude', 'a'); assert.equal(count, 3); now += 31; await reader.read('claude', 'a'); assert.equal(count, 4);
  reader.invalidate(); await reader.read('claude', 'a'); assert.equal(count, 5);
  failed = true; now += 31;
  const stale = await reader.read('claude', 'a');
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0].percent, 5);
  assert.deepEqual((await reader.read('claude', 'b')).windows, []);
  disconnected = true;
  const unavailable = await reader.read('claude', 'a');
  assert.deepEqual(unavailable.windows, []);
  assert.doesNotMatch(JSON.stringify({ stale, unavailable }), /PRIVATE_/);
  await reader.close();
});

test('shutdown cancels owned native account readers and waits for their cleanup', async () => {
  let stopped = false;
  const reader = new AccountLimitsReader({ context: async () => ({ directory: 'account' }), claude: (_context, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(new Error('Stopped')); }, { once: true })) });
  const pending = reader.read('claude', 'a'); await new Promise(resolve => setImmediate(resolve)); await reader.close(); await pending;
  assert.equal(stopped, true); assert.equal(reader.pending.size, 0);
});

test('account changes invalidate an in-flight result and allow a fresh read before the old one completes', async () => {
  const finish = []; let count = 0;
  const reader = new AccountLimitsReader({ context: async () => ({ directory: 'same-profile' }), claude: () => new Promise(resolve => { count++; finish.push(resolve); }) });
  const old = reader.read('claude', 'a'); await new Promise(resolve => setImmediate(resolve)); reader.invalidate();
  const fresh = reader.read('claude', 'a'); await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 2);
  finish[1]({ windows: [{ label: 'new', percent: 4 }] }); assert.equal((await fresh).windows[0].percent, 4);
  finish[0]({ windows: [{ label: 'old', percent: 99 }] }); assert.deepEqual((await old).windows, []);
  assert.equal((await reader.read('claude', 'a')).windows[0].percent, 4); await reader.close();
});
