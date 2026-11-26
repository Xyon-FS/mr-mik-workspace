import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForCodexUnload } from '../codex-chat-worker-attachment.mjs';
import { Sessions } from '../sessions.mjs';

test('unload checks all native pages before releasing an owner', async () => {
  const transport = new EventEmitter(), calls = []; let passes = 0;
  transport.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (!params.cursor) return { data: ['other'], nextCursor: 'page-two' };
    return { data: passes++ ? [] : ['owned'] };
  };
  await waitForCodexUnload(transport, 'owned');
  assert.equal(passes, 2); assert.equal(calls.length, 5);
  assert.equal(transport.listenerCount('message'), 0);
});

test('closed notification before unsubscribe acknowledgment is retained and foreign notifications ignored', async () => {
  const transport = new EventEmitter(); let checks = 0, reportOwnedClose = false;
  transport.rpc = async method => {
    if (method === 'thread/unsubscribe') {
      transport.emit('message', { method: 'thread/closed', params: { threadId: 'other' } });
      if (reportOwnedClose) transport.emit('message', { method: 'thread/closed', params: { threadId: 'owned' } });
      return { status: 'unsubscribed' };
    }
    checks++; return { data: [] };
  };
  await waitForCodexUnload(transport, 'owned');
  assert.equal(checks, 1, 'A foreign close must still require a native unload check');
  reportOwnedClose = true;
  await waitForCodexUnload(transport, 'owned');
  assert.equal(checks, 1, 'An owned close emitted before the acknowledgement avoids a redundant check');
  assert.equal(transport.listenerCount('message'), 0);
});

test('invalid pagination and detach failure remove notification listeners', async () => {
  for (const failure of ['cursor', 'detach']) {
    const transport = new EventEmitter();
    transport.rpc = async method => method === 'thread/unsubscribe' ? { status: failure === 'detach' ? 'unknown' : 'unsubscribed' } : { data: [], nextCursor: 'same' };
    await assert.rejects(waitForCodexUnload(transport, 'owned'), failure === 'detach' ? /did not confirm/ : /repeated/);
    assert.equal(transport.listenerCount('message'), 0);
  }
});

test('a native close confirmed during a pending list read survives its RPC timeout', async () => {
  const transport = new EventEmitter();
  transport.rpc = async method => {
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    transport.emit('message', { method: 'thread/closed', params: { threadId: 'owned' } });
    throw Object.assign(new Error('Uncertain list read'), { uncertain: true });
  };
  await waitForCodexUnload(transport, 'owned');
  assert.equal(transport.listenerCount('message'), 0);
});

test('graphical Codex session awaits owned cleanup beyond the terminal timeout and preserves its cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish; const gate = new Promise(resolve => { finish = resolve; }); let stopped = false;
  const context = { requestStop() { stopped = true; } }, session = { agent: 'codex', chatInterface: 'chat' };
  let done = false; const closing = Sessions.prototype.closeProcess.call(context, session, { close: () => gate }).then(() => { done = true; });
  t.mock.timers.tick(9000); await Promise.resolve(); assert.equal(done, false); assert.equal(stopped, false);
  finish(); await closing;
  const cause = Object.assign(new Error('native unload still pending'), { code: 'CODEX_UNLOAD_PENDING' });
  await assert.rejects(Sessions.prototype.closeProcess.call(context, session, { close: async () => { throw cause; } }), error => error === cause);
});
