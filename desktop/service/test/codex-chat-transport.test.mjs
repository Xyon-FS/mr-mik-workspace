import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexChatTransport } from '../codex-chat-transport.mjs';

function fixture(t, { deferredStart = false } = {}) {
  const child = new EventEmitter(), sent = [];
  child.pid = 123;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('data', data => sent.push(...data.toString().trim().split('\n').map(line => JSON.parse(line))));
  child.kill = () => child.emit('exit', 0);
  const transport = new CodexChatTransport({ spawnChild: () => child });
  if (!deferredStart) transport.start('synthetic', [], {});
  const reply = message => child.stdout.write(JSON.stringify(message) + '\n');
  t.after(async () => {
    child.emit('exit', 0);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await transport.close();
  });
  return { transport, child, sent, reply };
}

test('transport routes out-of-order replies while preserving native request IDs', async t => {
  const { transport, sent, reply } = fixture(t), native = [];
  transport.on('message', message => native.push(message));
  const initializing = transport.initialize();
  assert.equal(transport.initialize(), initializing);
  reply({ id: sent[0].id, result: { userAgent: 'synthetic' } });
  await initializing;
  assert.deepEqual(sent.splice(0).map(message => message.method), ['initialize', 'initialized']);

  const first = transport.rpc('thread/read', { threadId: 'A' });
  const second = transport.rpc('thread/read', { threadId: 'B' });
  assert.notEqual(sent[0].id, sent[1].id);
  reply({ id: sent[0].id, method: 'item/commandExecution/requestApproval', params: { threadId: 'B' } });
  assert.equal(transport.pending.size, 2);
  assert.equal(native[0].params.threadId, 'B');
  reply({ id: sent[1].id, result: { thread: { id: 'B' } } });
  reply({ id: sent[0].id, result: { thread: { id: 'A' } } });
  assert.equal((await first).thread.id, 'A'); assert.equal((await second).thread.id, 'B');
  transport.send({ id: native[0].id, result: { decision: 'decline' } });
  assert.equal(sent.at(-1).id, native[0].id);
  assert.equal(transport.pending.size, 0);
});

test('timed-out requests are never replayed and late replies cannot resolve a new request', async t => {
  const { transport, sent, reply } = fixture(t);
  await assert.rejects(transport.rpc('turn/start', { threadId: 'A' }, 5), error => error.uncertain === true);
  const expiredId = sent[0].id;
  const next = transport.rpc('thread/read', { threadId: 'A' });
  reply({ id: expiredId, result: { wrong: true } });
  assert.equal(transport.pending.size, 1);
  reply({ id: sent[1].id, result: { verified: true } });
  assert.deepEqual(await next, { verified: true });
  assert.equal(sent.filter(message => message.method === 'turn/start').length, 1);
});

test('initialization is shared by concurrent callers and never retried after rejection', async t => {
  const { transport, sent, reply } = fixture(t);
  const first = transport.initialize(), second = transport.initialize();
  assert.equal(first, second);
  reply({ id: sent[0].id, error: { message: 'Synthetic account rejection' } });
  await assert.rejects(first, error => error.nativeRejected === true && !error.uncertain);
  await assert.rejects(transport.initialize(), /Synthetic account rejection/);
  assert.equal(sent.length, 1);
});

test('shutdown waits for actual exit, rejects pending delivery and emits exit once', async t => {
  const { transport, child } = fixture(t);
  const pending = assert.rejects(transport.rpc('turn/start', { threadId: 'A' }), /not been resent/);
  let exits = 0; transport.on('exit', () => exits++);
  const closing = transport.close();
  assert.equal(transport.close(), closing);
  assert.equal(transport.closed, false);
  assert.equal(exits, 0);
  child.emit('exit', 7); child.emit('exit', 7);
  await Promise.all([pending, closing]);
  assert.equal(exits, 1); assert.equal(transport.pending.size, 0);
  await assert.rejects(transport.rpc('thread/read', {}), /disconnected/);
});

test('invalid lines do not expose stderr diagnostics or approve native actions', async t => {
  const { transport, child, sent, reply } = fixture(t);
  let invalid = 0, notifications = 0;
  transport.on('invalid', () => invalid++);
  transport.on('message', () => notifications++);
  child.stderr.write('Synthetic sensitive diagnostics');
  child.stdout.write('invalid JSON\n');
  reply({ method: 'turn/started', params: { threadId: 'A' } });
  assert.equal(invalid, 1); assert.equal(notifications, 1); assert.deepEqual(sent, []);
});
