// One real native process, two temporary roots; metadata controls only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexChatTransport } from '../codex-chat-transport.mjs';
import { graphicalCodexBinary } from '../codex-chat-binary.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-router-native-'));
const transport = new CodexChatTransport(), calls = [], issues = [];
try {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
  const home = path.join(root, 'home'); await mkdir(home);
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' });
  const allowed = new Set(['initialize', 'initialized', 'account/read', 'thread/start', 'thread/name/set', 'thread/read']);
  const send = transport.send.bind(transport);
  transport.send = message => { assert.ok(allowed.has(message.method), `Forbidden native acceptance method: ${message.method}`); calls.push(message.method); send(message); };
  const owners = ['A', 'B'].map(() => {
    const messages = [];
    return { messages, binding: transport.router.attach({ onMessage: message => messages.push(message), onIssue: message => issues.push(message) }) };
  });
  const binary = graphicalCodexBinary();
  transport.start(binary.file, [...binary.args, 'app-server', '--stdio'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  transport.on('fault', () => { throw new Error('Native routing acceptance transport failed'); });
  await transport.initialize();
  assert.equal((await transport.rpc('account/read', { refreshToken: false })).account, null);
  const results = await Promise.all(owners.map(() => transport.rpc('thread/start', { cwd: root })));
  assert.notEqual(results[0].thread.id, results[1].thread.id);
  owners[1].binding.bindRoot(results[1].thread.id); owners[0].binding.bindRoot(results[0].thread.id);
  await Promise.all(owners.map((_, i) => transport.rpc('thread/name/set', { threadId: results[i].thread.id, name: `Synthetic routing ${i}` })));
  for (let attempt = 0; attempt < 100 && owners.some(owner => !owner.messages.some(m => m.method === 'thread/name/updated')); attempt++) await delay(10);
  for (let i = 0; i < owners.length; i++) {
    const updates = owners[i].messages.filter(m => m.method === 'thread/name/updated');
    assert.ok(updates.length > 0);
    assert.ok(updates.every(m => m.params.threadId === results[i].thread.id));
  }
  const aCount = owners[0].messages.length;
  owners[0].binding.detach();
  await transport.rpc('thread/name/set', { threadId: results[1].thread.id, name: 'Synthetic B after A detach' });
  assert.equal(owners[0].messages.length, aCount);
  assert.equal((await transport.rpc('thread/read', { threadId: results[1].thread.id, includeTurns: false })).thread.id, results[1].thread.id);
  assert.equal(calls.filter(method => method === 'initialize').length, 1); assert.deepEqual(issues, []);
  console.log('PASS real native routing: one process, one initialization, two distinct roots, independent metadata notifications, detached A leaves B usable; no login, no inference.');
} finally {
  await transport.close();
  await cleanupFixtures();
}
