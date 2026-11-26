// Explicit native acceptance: disposable homes, no login, no inference.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexChat } from '../codex-chat.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-transport-native-'));
const runtimes = [], calls = [];
const allowed = new Set(['initialize', 'initialized', 'thread/start', 'thread/read', 'account/read', 'windowsSandbox/readiness', 'collaborationMode/list']);
try {
  for (const name of ['A', 'B']) {
    const cwd = path.join(root, name), home = path.join(root, `${name}-home`);
    await mkdir(cwd); await mkdir(home);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
    const runtime = new CodexChat({ session: { cwd, codexPermissions: 'ask', effort: 'medium' }, env });
    runtimes.push(runtime);
    const send = runtime.transport.send.bind(runtime.transport);
    runtime.transport.send = message => {
      assert.ok(allowed.has(message.method), `Native acceptance must not dispatch ${message.method}`);
      calls.push({ owner: name, method: message.method });
      return send(message);
    };
  }
  await Promise.all(runtimes.map(runtime => runtime.start()));
  const [a, b] = runtimes;
  assert.notEqual(a.threadId, b.threadId);
  assert.notEqual(a.transport.child.pid, b.transport.child.pid);
  for (const runtime of runtimes) {
    assert.equal((await runtime.rpc('account/read', { refreshToken: false })).account, null);
    assert.equal((await runtime.rpc('thread/read', { threadId: runtime.threadId, includeTurns: false })).thread.id, runtime.threadId);
    assert.equal(runtime.snapshot().connected, true);
  }
  await a.close();
  assert.equal(a.closed, true); assert.equal(b.snapshot().connected, true);
  assert.equal((await b.rpc('thread/read', { threadId: b.threadId, includeTurns: false })).thread.id, b.threadId);
  assert.equal(calls.filter(call => call.method === 'initialize').length, 2);
  console.log('PASS native dedicated transports: concurrent isolated roots/processes, initialization, logged-out account checks, thread reads and independent close; zero inference and no real profiles.');
} finally {
  await Promise.all(runtimes.map(runtime => runtime.close()));
  await cleanupFixtures();
}
