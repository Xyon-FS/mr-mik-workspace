// Full CodexChat attachments on one native worker; controls only, no login.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { CodexChat } from '../codex-chat.mjs';
import { CodexWorkerPool } from '../codex-worker-pool.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-pooled-runtime-native-'));
const pool = new CodexWorkerPool({ maxIdle: 2 }), runtimes = [], samples = [];
try {
  const home = path.join(root, 'home'); await mkdir(home);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
  const account = { profileId: 'synthetic', privateHome: home, configRevision: 'synthetic', conversationStoreId: 'synthetic' };
  for (let i = 0; i < 3; i++) {
    const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'medium' }, env, account, workerPool: pool, stateDir: root });
    runtimes.push(runtime);
    const rpc = runtime.rpc.bind(runtime);
    runtime.rpc = (method, params, timeout) => {
      assert.ok(['thread/start', 'thread/read', 'windowsSandbox/readiness', 'collaborationMode/list', 'account/read'].includes(method), `Forbidden native acceptance method: ${method}`);
      return rpc(method, params, timeout);
    };
    const start = performance.now(); await runtime.start(); samples.push(Math.round(performance.now() - start));
  }
  const burst = await Promise.all([0, 1, 2].map(async () => {
    const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'medium' }, env, account, workerPool: pool, stateDir: root });
    runtimes.push(runtime);
    const rpc = runtime.rpc.bind(runtime);
    runtime.rpc = (method, params, timeout) => { assert.ok(['thread/start', 'thread/read', 'windowsSandbox/readiness', 'collaborationMode/list', 'account/read'].includes(method)); return rpc(method, params, timeout); };
    const start = performance.now(); await runtime.start(); return Math.round(performance.now() - start);
  }));
  const [a, b, c] = runtimes;
  assert.ok(a.workerLease); assert.ok(runtimes.every(runtime => runtime.transport === a.transport));
  assert.equal(new Set(runtimes.map(runtime => runtime.threadId)).size, 6);
  await assert.rejects(a.rpc('thread/read', { threadId: b.threadId }), /does not belong/);
  // Exercise native lazy-persistence handoff without spending an inference turn.
  console.log(JSON.stringify({ nativeHistoryMode: a.historyMode }));
  await a.rpc('thread/read', { threadId: a.threadId, includeTurns: true }).catch(error => {
    if (!error.nativeRejected || !/list_turns is not supported yet/.test(error.message)) throw error;
  });
  const durable = await a.rpc('thread/read', { threadId: a.threadId, includeTurns: false });
  assert.ok(durable.thread.path && await stat(durable.thread.path));
  await a.close();
  assert.equal(a.closed, true); assert.equal(b.closed, false); assert.equal(c.closed, false);
  assert.equal((await b.rpc('thread/read', { threadId: b.threadId, includeTurns: false })).thread.id, b.threadId);
  assert.equal((await c.rpc('account/read', { refreshToken: false })).account, null);
  const resumed = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'low' }, env, account: { ...account, profileId: 'other-synthetic-account' }, workerPool: pool, stateDir: root });
  runtimes.push(resumed); await resumed.start(a.threadId); assert.equal(resumed.threadId, a.threadId); assert.notEqual(resumed.transport, a.transport); await resumed.close();
  await Promise.all(runtimes.slice(1).map(runtime => runtime.close()));
  assert.equal(pool.retained.size, 2);
  const replacement = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'low' }, env, account, workerPool: pool, stateDir: root });
  runtimes.push(replacement); await replacement.start(); assert.equal(replacement.transport, a.transport);
  assert.notEqual(replacement.threadId, a.threadId); await replacement.close();
  await pool.invalidate(); assert.equal(pool.retained.size, 0);
  console.log(JSON.stringify({ passed: true, nativeControlsOnly: true, startupMs: samples, burstMs: burst, roots: 8, idleRetentionAndInvalidation: true, persistedCrossProcessResume: true, paidPrompts: 0 }));
} finally {
  await Promise.allSettled(runtimes.map(runtime => runtime.close()));
  await pool.close();
  await cleanupFixtures();
}
