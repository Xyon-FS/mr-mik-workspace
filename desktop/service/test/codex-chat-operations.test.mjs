import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { projectChatItem } from '../codex-chat-items.mjs';

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-operations-'));
  const transport = graphicalFixture({ approval: true, ...settings });
  const r = new CodexChat({ session: { cwd: root, codexPermissions: 'auto-review', effort: 'medium', accountProfileId: 'synthetic' }, env: { ...process.env, CODEX_HOME: root }, spawnChild: transport.spawnChild });
  t.after(async () => { await r.close(); for (const child of transport.children) child.kill(); });
  await r.start(); return { r, transport };
}
async function settle(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await delay(5); assert.ok(predicate(), 'Synthetic events did not settle'); }

test('compaction confirms selected thread settings and waits for terminal outcome; it blocks sends, steer and duplicate actions', async t => {
  const { r, transport } = await fixture(t);
  r.draft = 'Keep me'; await assert.rejects(r.operations.start('compact'), /draft/); assert.equal(r.draft, 'Keep me'); r.draft = '';
  r.attachments = [path.join(r.session.cwd, 'keep.txt')]; await assert.rejects(r.operations.start('compact'), /attachments/); r.attachments = [];
  r.permissions.uncertain = true; await assert.rejects(r.operations.start('compact'), /Finish/); r.permissions.uncertain = false;
  r.requests.set('pending', {}); await assert.rejects(r.operations.start('review', { type: 'uncommittedChanges' }), /Finish/);
  assert.equal(transport.calls.some(call => ['review/start', 'thread/compact/start'].includes(call.method)), false);
  r.requests.delete('pending');
  r.model = 'fixture-alternate'; await r.operations.start('compact');
  assert.equal(r.operations.busy, true); assert.equal(r.idle(), false); assert.equal(r.operations.snapshot().status, 'running');
  const settings = transport.calls.find(call => call.method === 'thread/settings/update').params;
  assert.deepEqual(settings, { threadId: r.threadId, model: 'fixture-alternate', effort: 'medium' });
  assert.equal(settings.approvalPolicy, undefined); assert.equal(r.session.codexPermissions, 'auto-review');
  await assert.rejects(r.submit('Should not start'), /Finish/);
  await assert.rejects(r.advanced.steer('No steering compact', r.turnId), /active turn/);
  await assert.rejects(r.operations.start('compact'), /Finish/);
  const rpc = r.rpc.bind(r); let reply;
  r.rpc = (method, params) => method === 'thread/read' ? new Promise(resolve => { reply = resolve; }) : rpc(method, params);
  const checking = r.operations.check();
  transport.children[0].finishOperation(); await settle(() => !r.operations.busy);
  assert.equal(r.operations.snapshot().status, 'completed'); assert.equal(r.idle(), true);
  assert.equal(transport.calls.filter(call => call.method === 'thread/compact/start').length, 1);
  assert.equal(transport.calls.some(call => call.method === 'turn/start' || call.method === 'thread/resume'), false);
  await r.operations.start('review', { type: 'uncommittedChanges' });
  reply({ thread: { id: r.threadId, status: { type: 'idle' } } }); await checking;
  assert.equal(r.operations.snapshot().kind, 'review'); assert.equal(r.operations.snapshot().status, 'running'); assert.equal(r.operations.busy, true);
});

test('inline review validates target, keeps account/permission metadata and renders its native result, including completion before RPC response', async t => {
  const { r, transport } = await fixture(t, { completeBeforeResponse: true });
  await assert.rejects(r.operations.start('review', { type: 'commit', sha: 'bad hash' }), /Choose/);
  await r.operations.start('review', { type: 'baseBranch', branch: ' main ' });
  assert.equal(r.operations.snapshot().status, 'completed'); assert.equal(r.turnId, null);
  const request = transport.calls.find(call => call.method === 'review/start').params;
  assert.deepEqual(request, { threadId: r.threadId, delivery: 'inline', target: { type: 'baseBranch', branch: 'main' } });
  assert.equal(r.session.accountProfileId, 'synthetic'); assert.equal(r.session.codexPermissions, 'auto-review');
  assert.match([...r.items.values()].find(item => item.type === 'exitedReviewMode').text, /no actionable findings/);
});

test('uncertain operations survive restart, never replay, and an idle check is not called successful completion', async t => {
  const { r, transport } = await fixture(t), rpc = r.rpc.bind(r);
  r.rpc = (method, params) => method === 'thread/compact/start' ? Promise.reject(new Error('Synthetic lost response')) : rpc(method, params);
  await assert.rejects(r.operations.start('compact'), /lost response/);
  assert.equal(r.operations.snapshot().status, 'uncertain'); assert.equal(r.operations.busy, true);
  const saved = r.advanced.save(); r.operations.operation = null; r.advanced.restore(saved);
  assert.equal(r.operations.snapshot().status, 'uncertain'); assert.equal(r.idle(), false);
  await r.operations.check(); assert.equal(r.operations.snapshot().status, 'unconfirmed'); assert.equal(r.idle(), true);
  assert.equal(transport.calls.some(call => call.method === 'thread/compact/start' || call.method === 'turn/start'), false);
  r.rpc = (method, params) => method === 'thread/compact/start' ? Promise.resolve({}) : rpc(method, params);
  await r.operations.start('compact'); await r.operations.check();
  assert.equal(r.operations.busy, true);
  r.operations.operation.submittedAt -= 6000; await r.operations.check();
  assert.equal(r.operations.snapshot().status, 'unconfirmed'); assert.equal(r.operations.busy, false);
});

test('agent navigation reads only referenced children, bounds output, projects public summaries, and never resumes or executes them', async t => {
  const { r, transport } = await fixture(t);
  r.upsert({ id: 'agent-call', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child-fixture'], agentsStates: { 'child-fixture': { status: 'running', message: 'Inspecting' } }, prompt: 'Inspect source' });
  assert.deepEqual(r.items.get('agent-call').agents, [{ id: 'child-fixture', status: 'running', message: 'Inspecting' }]);
  transport.history.set('child-fixture', [...Array.from({ length: 60 }, (_, i) => ({ id: `message-${i}`, type: 'agentMessage', text: `Result ${i}` })), { id: 'reason', type: 'reasoning', content: ['PRIVATE'], summary: ['Public progress'] }]);
  await assert.rejects(r.operations.readAgent('unrelated'), /referenced/);
  const agent = await r.operations.readAgent('child-fixture');
  assert.equal(agent.name, 'Fixture agent'); assert.equal(agent.role, 'explorer'); assert.equal(agent.items.length, 50);
  assert.equal(agent.items.at(-1).text, 'Public progress'); assert.equal(JSON.stringify(agent).includes('PRIVATE'), false);
  assert.equal(transport.calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), false);
  assert.equal(projectChatItem({ id: 'review', type: 'exitedReviewMode', review: 'Review output' }).text, 'Review output');
});

test('protected restarts wait for referenced child threads to be natively idle', async t => {
  const { r } = await fixture(t);
  r.upsert({ id: 'agent-call', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child-fixture'], agentsStates: { 'child-fixture': { status: 'running', message: 'Inspecting' } } });
  assert.equal(r.ready(), false);
  r.rpc = async (_method, params) => ({ thread: { id: params.threadId, status: { type: 'active' } } });
  await r.operations.refreshAgentStatuses(); assert.equal(r.ready(), false);
  r.rpc = async (_method, params) => ({ thread: { id: params.threadId, status: { type: 'idle' } } });
  await r.operations.refreshAgentStatuses(); assert.equal(r.ready(), true);
  let finish;
  r.rpc = () => new Promise(resolve => { finish = resolve; });
  const pending = r.operations.refreshAgentStatuses();
  r.upsert({ id: 'new-agent-call', type: 'collabAgentToolCall', tool: 'sendInput', status: 'completed', receiverThreadIds: ['child-fixture'], agentsStates: { 'child-fixture': { status: 'running', message: 'New work' } } });
  finish({ thread: { id: 'child-fixture', status: { type: 'idle' } } }); await pending;
  assert.equal(r.ready(), false, 'A stale native idle read must not release newer child work');
});
