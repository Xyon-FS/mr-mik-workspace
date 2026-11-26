// Full CodexChat attachments on one native worker; controls only, no login.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexChat } from '../codex-chat.mjs';
import { CodexWorkerPool } from '../codex-worker-pool.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-pooled-runtime-native-'));
const pool = new CodexWorkerPool(), runtimes = [], samples = [];
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
  await a.close();
  assert.equal(a.closed, true); assert.equal(b.closed, false); assert.equal(c.closed, false);
  assert.equal((await b.rpc('thread/read', { threadId: b.threadId, includeTurns: false })).thread.id, b.threadId);
  assert.equal((await c.rpc('account/read', { refreshToken: false })).account, null);
  await Promise.all(runtimes.slice(1).map(runtime => runtime.close()));
  assert.equal(pool.retained.size, 0);
  console.log(JSON.stringify({ passed: true, nativeControlsOnly: true, startupMs: samples, burstMs: burst, roots: 6, workers: 1, paidPrompts: 0 }));
} finally {
  await Promise.allSettled(runtimes.map(runtime => runtime.close()));
  await pool.close();
  await cleanupFixtures();
}
