import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { prepareMessageAction, createMessageBranch } from '../chat-message-actions.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-message-actions-'));
  const turns = new Map(), transport = graphicalFixture({ turnHistory: turns, completeBeforeResponse: true });
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  t.after(() => sessions.close());
  const created = await sessions.create({ name: 'Original', agent: 'codex', chatInterface: 'chat', cwd: root, accountProfileId: 'fixture-account', graphicalModel: 'fixture-model', effort: 'medium', codexPermissions: 'bypass' });
  const source = sessions.get(created.id), runtime = source.graphical;
  const original = [1, 2, 3].map(number => ({ id: `turn-${number}`, status: 'completed', items: [{ id: `user-${number}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${number}` }] }, { id: `answer-${number}`, type: 'agentMessage', text: `Answer ${number}`, status: 'completed' }] }));
  turns.set(runtime.threadId, original);
  for (const turn of original) { runtime.rememberTurn(turn); for (const item of turn.items) runtime.upsert(item, { turnId: turn.id }); }
  source.activity = 'idle'; runtime.draft = 'Keep my original draft'; runtime.advanced.modeIntent = 'plan';
  return { root, sessions, source, runtime, transport, turns, original };
}

test('branch includes selected turn, edit excludes it; original, account, model, permissions and drafts are preserved', async t => {
  const f = await fixture(t);
  const branch = await createMessageBranch({ ...f, itemId: 'answer-2', kind: 'branch' });
  const child = f.sessions.get(branch.session.id);
  assert.equal(branch.submitted, false); assert.equal(child.accountProfileId, f.source.accountProfileId);
  assert.equal(child.graphicalModel, f.source.graphicalModel); assert.equal(child.codexPermissions, 'bypass');
  assert.equal(child.effort, 'medium'); assert.equal(child.graphical.advanced.modeIntent, 'plan');
  assert.deepEqual(f.turns.get(child.nativeId).map(turn => turn.id), ['turn-1', 'turn-2']);
  assert.equal(f.transport.calls.filter(call => call.method === 'turn/start').length, 0);
  const edited = await createMessageBranch({ ...f, itemId: 'user-2', kind: 'edit' });
  const edit = f.sessions.get(edited.session.id);
  assert.deepEqual(f.turns.get(edit.nativeId).map(turn => turn.id), ['turn-1']);
  assert.equal(edit.graphical.draft, 'Prompt 2'); assert.equal(f.runtime.draft, 'Keep my original draft');
  assert.equal(f.turns.get(f.source.nativeId).length, 3);
  const saved = JSON.parse(await readFile(path.join(f.root, 'state', `graphical-draft-${edit.id}.json`), 'utf8'));
  assert.equal(saved.text, 'Prompt 2'); assert.equal(f.runtime.messageActionBusy, false);
});

test('retry forks before selected turn and starts exactly one new response with original attachment scope', async t => {
  const f = await fixture(t), image = path.join(f.root, 'fixture.png'); await writeFile(image, 'synthetic image');
  f.original[1].items[0].content = [{ type: 'text', text: `Image prompt\n\nAttached paths:\n${JSON.stringify(image)}` }, { type: 'localImage', path: image }];
  const retry = await createMessageBranch({ ...f, itemId: 'answer-2', kind: 'retry' });
  assert.equal(retry.submitted, true);
  const child = f.sessions.get(retry.session.id);
  assert.deepEqual(f.turns.get(child.nativeId).map(turn => turn.id), ['turn-1']);
  const starts = f.transport.calls.filter(call => call.method === 'turn/start');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.threadId, child.nativeId);
  assert.equal(starts[0].params.input[0].text, `Image prompt\n\nAttached paths:\n${JSON.stringify(image)}`);
  assert.equal(starts[0].params.input.filter(part => part.type === 'localImage').length, 1);
  assert.equal(f.runtime.draft, 'Keep my original draft');
});

test('unknown anchors, active turns, steered inputs, missing attachments and unsupported context fail without inference', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareMessageAction(f.runtime, 'unknown', 'retry'), /Reload/);
  f.original[1].status = 'inProgress';
  await assert.rejects(createMessageBranch({ ...f, itemId: 'answer-2', kind: 'retry' }), /settled/);
  f.original[1].status = 'completed'; f.original[1].items.push({ id: 'steer', type: 'userMessage', content: [{ type: 'text', text: 'Steer' }] });
  await assert.rejects(createMessageBranch({ ...f, itemId: 'answer-2', kind: 'retry' }), /multiple steered/);
  f.original[1].items.pop(); f.original[1].items[0].content.push({ type: 'localImage', path: path.join(f.root, 'missing.png') });
  await assert.rejects(createMessageBranch({ ...f, itemId: 'answer-2', kind: 'retry' }), /attachment/i);
  f.original[1].items[0].content = [{ type: 'image', url: 'https://example.com/unsupported' }];
  await assert.rejects(createMessageBranch({ ...f, itemId: 'answer-2', kind: 'retry' }), /context/);
  assert.equal(f.runtime.messageActionBusy, false);
  assert.equal(f.sessions.items.size, 1); assert.equal(f.transport.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('paginated anchors are checked against full native turn items instead of trusting client turn IDs', async t => {
  const f = await fixture(t), rpc = f.runtime.rpc.bind(f.runtime); let pages = 0;
  f.runtime.historyMode = 'paginated';
  f.runtime.rpc = async (method, params) => {
    if (method !== 'thread/turns/list') return rpc(method, params);
    assert.equal(params.itemsView, 'full'); pages++;
    return params.cursor ? { data: [f.original[1]] } : { data: [f.original[2]], nextCursor: 'older' };
  };
  const plan = await prepareMessageAction(f.runtime, 'answer-2', 'branch');
  assert.deepEqual(plan.anchor, { lastTurnId: 'turn-2' }); assert.equal(pages, 2);
  f.runtime.items.get('answer-2').turnId = 'turn-unrelated';
  await assert.rejects(prepareMessageAction(f.runtime, 'answer-2', 'branch'), /settled/);
});
