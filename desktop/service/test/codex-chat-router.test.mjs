import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexChatRouter } from '../codex-chat-router.mjs';

function fixture() {
  const sent = [], router = new CodexChatRouter(message => sent.push(message));
  const owner = (root = null) => {
    const messages = [], children = [], globals = [], issues = [];
    const binding = router.attach({ onMessage: m => messages.push(m), onChild: m => children.push(m), onGlobal: m => globals.push(m), onIssue: m => issues.push(m) });
    if (root) binding.bindRoot(root);
    return { binding, messages, children, globals, issues };
  };
  const notify = (method, params) => router.route({ method, params });
  const request = (id, threadId, turnId = 'turn') => router.route({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
  return { router, owner, notify, request, sent };
}

test('routes only to explicit roots despite identical turn/item IDs and reversed binding order', () => {
  const { router, owner, notify, request, sent } = fixture(), a = owner(), b = owner();
  notify('turn/started', { threadId: 'A', turn: { id: 'same-turn' } });
  notify('turn/started', { threadId: 'B', turn: { id: 'same-turn' } });
  notify('item/agentMessage/delta', { threadId: 'B', itemId: 'same-item', delta: 'B only' });
  request(5, 'A'); notify('serverRequest/resolved', { requestId: 5 });
  assert.equal(a.messages.length, 0);
  b.binding.bindRoot('B'); a.binding.bindRoot('A');
  assert.equal(a.messages.length, 3); assert.equal(b.messages.length, 2);
  assert.equal(b.messages[1].params.delta, 'B only');
  notify('turn/completed', { threadId: 'unknown', turn: { id: 'same-turn' } });
  notify('turn/completed', { turn: { id: 'same-turn' } });
  assert.equal(a.messages.length, 3); assert.equal(b.messages.length, 2);
  assert.throws(() => a.binding.bindRoot('B'), /ownership/);
  assert.deepEqual(a.messages.slice(1).map(m => m.method), ['item/commandExecution/requestApproval', 'serverRequest/resolved']);
  assert.equal(router.requests.size, 0);
  router.route({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(a.messages.length, 3);
  assert.equal(a.issues.length, 1);
  assert.throws(() => a.binding.send({ id: 1, result: { decision: 'accept' } }), /does not belong/);
  assert.equal(sent.length, 0);
  router.clear();
});

test('approvals and threadless resolutions retain ownership and cannot be answered by another chat', () => {
  const { router, owner, request, notify, sent } = fixture(), a = owner('A'), b = owner('B');
  request(1, 'A'); request(2, 'B');
  assert.throws(() => b.binding.send({ id: 1, result: { decision: 'accept' } }), /does not belong/);
  notify('serverRequest/resolved', { threadId: 'B', requestId: 1 });
  notify('serverRequest/resolved', { requestId: '1' });
  assert.equal(a.messages.length, 1); assert.equal(router.requests.size, 2);
  a.binding.send({ id: 1, result: { decision: 'decline' } });
  assert.throws(() => a.binding.send({ id: 1, result: { decision: 'accept' } }), /already/);
  notify('serverRequest/resolved', { requestId: 1 });
  assert.equal(a.messages.at(-1).params.threadId, 'A');
  assert.equal(b.messages.length, 1); assert.equal(router.requests.size, 1); assert.equal(sent.length, 1);
  request(3, 'A'); a.binding.send({ id: 3, result: { decision: 'decline' } }); request(3, 'A');
  assert.equal(a.messages.length, 3);
  request(3, 'B');
  assert.equal(a.issues.length, 1); assert.equal(b.issues.length, 1);
  assert.equal(b.messages.length, 1);
  assert.throws(() => a.binding.send({ id: 3, result: { decision: 'accept' } }), /already/);
  assert.throws(() => b.binding.send({ id: 3, result: { decision: 'accept' } }), /does not belong/);
  const previousIssues = a.issues.length;
  request(7, 'A'); request('7', 'A');
  assert.ok(a.issues.length > previousIssues);
  assert.throws(() => a.binding.send({ id: 7, result: { decision: 'accept' } }), /already/);
  assert.equal(sent.length, 2);
});

test('spawned children and descendants have a separate channel and cannot claim another root', () => {
  const { owner, notify, request, router, sent } = fixture(), a = owner('A'), b = owner('B');
  notify('thread/status/changed', { threadId: 'child', status: { type: 'active' } });
  a.binding.observeItem({ type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: ['child'] });
  assert.equal(a.children.length, 0);
  a.binding.observeItem({ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child', 'B'] });
  assert.equal(a.children.length, 1); assert.equal(a.messages.length, 0); assert.equal(a.issues.length, 1);
  notify('item/completed', { threadId: 'child', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['grandchild'] } });
  notify('turn/completed', { threadId: 'grandchild', turn: { id: 'child-turn' } });
  request(9, 'grandchild');
  assert.equal(a.children.at(-1).params.threadId, 'grandchild');
  assert.equal(a.messages.length, 0); assert.equal(b.children.length, 0); assert.equal(b.messages.length, 0);
  request(1, 'A'); request(2, 'B'); a.binding.detach();
  notify('item/completed', { threadId: 'A', item: { id: 'late' } });
  notify('serverRequest/resolved', { requestId: 2 });
  assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 2);
  assert.throws(() => a.binding.send({ id: 1, result: { decision: 'accept' } }), /does not belong/);
  assert.equal(router.threads.has('child'), false); assert.equal(router.threads.has('grandchild'), false); assert.equal(sent.length, 0);
  router.clear(); assert.equal(router.buffer.length, 0); assert.equal(router.owners.size, 0);
});

test('process-global notifications are explicit; sandbox completion belongs only to its initiator', () => {
  const { owner, notify } = fixture(), a = owner('A'), b = owner('B');
  notify('account/rateLimits/updated', { rateLimits: {} });
  notify('error', { error: { message: 'unowned' } });
  notify('thread/settings/updated', { threadSettings: { model: 'unowned' } });
  assert.equal(a.globals.length, 1); assert.equal(b.globals.length, 1);
  a.binding.expect('windowsSandbox/setupCompleted');
  notify('windowsSandbox/setupCompleted', { mode: 'unelevated', success: true });
  assert.equal(a.globals.length, 1);
  assert.throws(() => b.binding.expect('windowsSandbox/setupCompleted'), /Another conversation/);
  notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true });
  assert.equal(a.globals.length, 2); assert.equal(b.globals.length, 1);
  notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true });
  assert.equal(a.globals.length, 2);
  a.binding.expect('windowsSandbox/setupCompleted');
  a.binding.cancelExpected('windowsSandbox/setupCompleted');
  b.binding.expect('windowsSandbox/setupCompleted');
  notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true });
  assert.equal(a.globals.length, 2); assert.equal(b.globals.length, 2);
});

test('unowned startup buffers are bounded and overflow never silently authorizes a ready chat', () => {
  const { router, owner, notify } = fixture(), a = owner();
  for (let i = 0; i < 300; i++) notify('item/agentMessage/delta', { threadId: 'A', itemId: 'item', delta: 'x' });
  assert.equal(router.buffer.length, 256); assert.ok(router.bufferBytes <= 4 * 1024 * 1024);
  a.binding.bindRoot('A');
  assert.equal(a.messages.length, 256); assert.equal(a.issues.length, 1); assert.equal(router.bufferBytes, 0);
});
