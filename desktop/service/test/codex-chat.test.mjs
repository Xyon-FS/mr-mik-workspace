import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexChat } from '../codex-chat.mjs';
import { Sessions } from '../sessions.mjs';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-graphical-test-'));
  const transport = graphicalFixture(options);
  const session = { cwd: root, codexPermissions: 'ask', effort: 'medium' };
  const runtime = new CodexChat({ session, env: process.env, spawnChild: transport.spawnChild, bridge: { script: path.join(root, 'bridge.mjs'), instructions: 'Scoped fixture only.', codexWritableRoots: false }, browser: { serverName: 'fixture_browser', command: process.execPath, args: ['fixture'] } });
  t.after(() => runtime.close()); await runtime.start(); return { runtime, transport, root };
}

test('Stop waits for native completion, recovers a lost notification and permits another turn', async t => {
  const { runtime: r, transport } = await fixture(t);
  const child = transport.children[0], turn = { id: 'lost-stop-result', status: 'inProgress' };
  child.notify('turn/started', { threadId: r.threadId, turn }); await delay(1);
  const rpc = r.rpc.bind(r);
  let stopped = false;
  const read = () => ({ thread: { status: { type: stopped ? 'idle' : 'active' }, turns: [{ ...turn, status: stopped ? 'interrupted' : 'inProgress' }] } });
  r.rpc = (method, params, timeout) => method === 'thread/read' ? Promise.resolve(read()) : rpc(method, params, timeout);
  await assert.rejects(r.interrupt(), /still active/);
  assert.equal(r.snapshot().working, true);
  assert.equal(r.snapshot().canInterrupt, true);
  stopped = true;
  await r.interrupt();
  assert.equal(r.snapshot().working, false); assert.equal(r.turnId, null);
  assert.equal(r.turns.get(turn.id).status, 'interrupted'); assert.equal(r.advanced.paused, true);
  assert.equal(transport.calls.filter(call => call.method === 'turn/interrupt').length, 2);
  await r.submit('A new synthetic request'); await delay(20); assert.equal(r.snapshot().working, false);
});

for (const paginated of [false, true]) test(`a refused Steer reconciles a stale ${paginated ? 'paginated' : 'legacy'} active turn without replaying guidance`, async t => {
  const { runtime: r, transport } = await fixture(t);
  if (paginated) r.historyMode = 'paginated';
  const turn = { id: 'already-completed', status: 'inProgress' };
  transport.children[0].notify('turn/started', { threadId: r.threadId, turn }); await delay(1);
  const rpc = r.rpc.bind(r); let guidanceCalls = 0;
  r.rpc = (method, params, timeout) => {
    if (method === 'turn/steer') { guidanceCalls++; return Promise.reject(Object.assign(new Error('Turn is no longer active'), { nativeRejected: true })); }
    if (method === 'thread/read') { if (paginated) assert.equal(params.includeTurns, false); return Promise.resolve({ thread: { status: { type: 'idle' }, ...(paginated ? {} : {turns: [{ ...turn, status: 'completed' }]}) } }); }
    if (method === 'thread/turns/list' && paginated) return Promise.resolve({data: [{...turn, status: 'completed'}]});
    return rpc(method, params, timeout);
  };
  await assert.rejects(r.advanced.steer('Keep this draft', turn.id), /no longer active/);
  assert.equal(guidanceCalls, 1); assert.equal(r.snapshot().working, false); assert.equal(r.uncertain, false);
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});

for (const known of [true, false]) test(`Stop recovers paginated native state with ${known ? 'known' : 'missing'} active turn identity`, async t => {
  const {runtime:r}=await fixture(t);r.historyMode='paginated';r.nativeActive=true;r.turnId=known?'paged-active':null;
  const rpc=r.rpc.bind(r);let stopped=false,interrupts=0,metadata=0;
  r.rpc=async(method,params,timeout)=>{
    if(method==='thread/read'){assert.equal(params.includeTurns,false,'Paginated threads must not request unsupported full hydration');return{thread:{id:r.threadId,status:{type:stopped?'idle':'active'}}};}
    if(method==='thread/turns/list'){metadata++;assert.equal(params.itemsView,'notLoaded');return{data:[{id:'paged-active',status:stopped?'interrupted':'inProgress'}]};}
    if(method==='turn/interrupt'){assert.equal(params.turnId,'paged-active');interrupts++;stopped=true;return{};}
    return rpc(method,params,timeout);
  };
  await r.interrupt();assert.equal(r.snapshot().working,false);assert.equal(r.turnId,null);assert.equal(interrupts,1);assert.ok(metadata>0);
});

test('early completion cannot resurrect a turn; accepted text is sent once and history is retained', async t => {
  const { runtime, transport } = await fixture(t, { completeBeforeResponse: true });
  runtime.draft = 'Multiline\nfixture'; await runtime.submit();
  assert.equal(runtime.turnId, null); assert.equal(runtime.ready(), true);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(runtime.snapshot().items.filter(item => item.type === 'agentMessage').length, 1);
  await assert.rejects(runtime.submit('/model'), /Slash commands/);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('approval decisions are explicit, single-use and scoped; unsupported requests fail closed', async t => {
  const { runtime, transport } = await fixture(t, { approval: true });
  await runtime.submit('Fixture approval');
  assert.equal(runtime.ready(), false); await assert.rejects(runtime.submit('duplicate'), /Finish/);
  runtime.answer('900', 'decline'); assert.throws(() => runtime.answer('900', 'accept'), /already/);
  assert.deepEqual(transport.calls.find(call => call.id === 900 && !call.method).result, { decision: 'decline' });
  transport.children[0].notify('serverRequest/resolved', { threadId: runtime.threadId, requestId: 900 });
  assert.equal(runtime.snapshot().requests.length, 0);
  transport.children[0].request(901, 'unknown/action', { threadId: runtime.threadId, details: 'x'.repeat(100000) });
  assert.equal(runtime.snapshot().requests[0].supported, false);
  assert.throws(() => runtime.answer('901', 'accept'), /not supported/);
  runtime.answer('901', 'cancel'); assert.equal(transport.calls.find(call => call.id === 901 && !call.method).error.code, -32601);
});

test('graphical session is persisted with native identity and reopens without launching a terminal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-graphical-session-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init(); t.after(() => sessions.close());
  const transport = graphicalFixture({ completeBeforeResponse: true });
  const account = { label: 'Synthetic', conversationStoreId: 'fixture', sqliteHome: path.join(root, 'sqlite'), env: process.env };
  await mkdir(account.sqliteHome);
  sessions.accountContext = async () => account;
  sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  sessions.permissionReady = session => session.graphical?.ready() === true;
  const chat = await sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'fixture', cwd: root });
  assert.equal(chat.chatInterface, 'chat'); assert.ok(chat.nativeId);
  sessions.get(chat.id).graphical.draft = 'Unsent draft';
  await assert.rejects(sessions.setInterface(chat.id, 'cli'), /clear drafts/);
  assert.throws(() => sessions.input(chat.id, 'Mik task', { coordinator: true, submit: true }), /graphical draft/);
  assert.equal(sessions.get(chat.id).chatInterface, 'chat');
  sessions.get(chat.id).graphical.draft = '';
  await sessions.input(chat.id, 'Synthetic request', { coordinator: true, submit: true });
  await delay(1); assert.match((await sessions.read(chat.id)).screen, /Fixture streamed answer/);
  await sessions.remove(chat.id); await sessions.resume(chat.id);
  assert.equal(sessions.get(chat.id).nativeId, chat.nativeId);
  assert.equal(transport.children.length, 2);
  await assert.rejects(sessions.create({ agent: 'shell', chatInterface: 'chat', cwd: root }), /Codex and Claude/);
});

test('dedicated transport extraction preserves concurrent chats through steer, Stop and close', async t => {
  const first = await fixture(t, { approval: true }), second = await fixture(t, { approval: true });
  const a = first.runtime, b = second.runtime;
  await Promise.all([a.submit('Synthetic A'), b.submit('Synthetic B')]);
  assert.notEqual(a.threadId, b.threadId); assert.notEqual(a.runtimeId, b.runtimeId);
  assert.notEqual(first.transport.children[0].options.cwd, second.transport.children[0].options.cwd);
  assert.equal(a.requests.size, 1); assert.equal(b.requests.size, 1);
  const bTurn = b.turnId, bRequests = [...b.requests.values()];
  // The native fixture uses request ID 900 in both independent processes.
  first.transport.children[0].notify('serverRequest/resolved', { threadId: a.threadId, requestId: 900 });
  await a.advanced.steer('Synthetic A guidance', a.turnId);
  assert.equal(first.transport.calls.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(second.transport.calls.filter(call => call.method === 'turn/steer').length, 0);
  await a.interrupt(); await a.close();
  assert.equal(a.closed, true); assert.equal(b.closed, false);
  assert.equal(b.turnId, bTurn); assert.equal(b.snapshot().working, true);
  assert.deepEqual([...b.requests.values()], bRequests);
  assert.equal(second.transport.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  await b.interrupt();
  assert.equal(b.snapshot().working, false);
});

test('child approvals remain explicitly answerable after root completion without allowing child messages', async t => {
  const { runtime: r, transport } = await fixture(t, { approval: true });
  await r.submit('Synthetic root');
  const child = transport.children[0], turnId = r.turnId;
  child.notify('item/completed', { threadId: r.threadId, item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
  child.request(901, 'item/commandExecution/requestApproval', { threadId: 'child', turnId: 'child-turn', command: 'synthetic-child-command' });
  assert.equal(r.requests.get('901').params.threadId, 'child'); assert.equal(r.turnId, turnId);
  child.notify('turn/completed', { threadId: r.threadId, turn: { id: turnId, status: 'completed' } });
  assert.equal(r.turnId, null); assert.equal(r.requests.size, 1); assert.equal(r.ready(), false);
  r.answer('901', 'decline');
  assert.deepEqual(transport.calls.find(message => message.id === 901 && !message.method).result, { decision: 'decline' });
  child.notify('serverRequest/resolved', { requestId: 901 });
  assert.equal(r.requests.size, 0);
  assert.equal(transport.calls.filter(message => message.method === 'turn/start').length, 1);
});
