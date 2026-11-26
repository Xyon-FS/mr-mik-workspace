import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CodexChat } from '../codex-chat.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';
import { mkdtemp } from './fixtures.mjs';

test('handled unsupported capability APIs settle the barrier and preserve the existing compatibility fallback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-compatible-')), wire = pooledCodexFixture();
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask', effort: 'low' }, env: { CODEX_HOME: root }, stateDir: root, sandboxStateDir: path.join(root, 'sandbox'), spawnChild: wire.spawnChild });
  t.after(() => runtime.close()); const rpc = runtime.rpc.bind(runtime);
  runtime.rpc = (method, ...args) => ['windowsSandbox/readiness', 'collaborationMode/list'].includes(method) ? Promise.reject(new Error('Synthetic unsupported API')) : rpc(method, ...args);
  await runtime.start();
  assert.equal(runtime.snapshot().connected, true); assert.equal(runtime.idle(), true);
  assert.equal(runtime.sandbox.status, 'unavailable'); assert.ok(runtime.advanced.modeError);
  assert.deepEqual(runtime.advanced.modes, []);
  assert.equal(wire.calls.some(call => call.method === 'turn/start'), false);
});
