import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-steer-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: root, agent: 'claude', effort: 'low' };
  const fixture = claudeFixture(session.nativeId, options);
  const create = () => new ClaudeChat({ session, stateDir: root, transportFactory: fixture.factory });
  const r = create(); await r.start();
  t.after(async () => { await r.close(); fixture.close(); });
  return { r, fixture, root, create, wire: [...fixture.transports][0] };
}
const users = fixture => fixture.calls.filter(call => call.type === 'user');
const turn = r => r.protocol.state.turns.at(-1).id;

test('Claude native guidance uses priority now in the active turn, persists before sending and deduplicates', async t => {
  const { r, fixture } = await setup(t);
  r.submit('slow'); const target = turn(r), id = randomUUID(); r.draft = 'guide';
  const events = []; r.on('native', event => events.push(event));
  const send = r.protocol.steer.bind(r.protocol);
  r.protocol.steer = (...args) => { const saved = JSON.parse(readFileSync(r.pending.file)); assert.equal(saved.steering.operation.status, 'sending'); assert.ok(saved.steering.receipts.includes(id)); return send(...args); };
  await r.steering.steer('guide', target, id);
  assert.equal(r.draft, ''); assert.equal(r.snapshot().turns.length, 1); assert.equal(turn(r), target);
  assert.equal(r.snapshot().turns[0].status, 'completed'); assert.equal(events.filter(event => event.kind === 'turn-completed').length, 1);
  assert.equal(users(fixture)[1].priority, 'now'); assert.equal(users(fixture)[1].uuid, id); assert.equal(users(fixture)[1].origin.kind, 'human');
  assert.equal(r.protocol.state.items.filter(item => item.type === 'userMessage').length, 2);
  await r.steering.steer('guide', target, id); assert.equal(users(fixture).length, 2);
  await r.pending.writes; assert.equal(JSON.parse(await readFile(r.pending.file, 'utf8')).steering.operation.status, 'completed');
});

test('Claude repeated guidance holds intermediate native results and never drains queued messages between them', async t => {
  const { r, wire, fixture } = await setup(t, { holdSteerResult: true });
  r.submit('slow'); const target = turn(r), first = randomUUID(), second = randomUUID();
  await r.pending.enqueue('after guidance', randomUUID());
  await r.steering.steer('guide one', target, first);
  wire.emit({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming', user_message_uuids: [users(fixture)[0].uuid], result: 'Partial old answer' });
  assert.equal(r.snapshot().status, 'running'); assert.equal(r.pending.paused, false);
  await r.steering.steer('guide two', target, second);
  wire.emit({ type: 'result', subtype: 'success', user_message_uuids: [first], result: 'Older guidance result' });
  assert.equal(r.snapshot().status, 'running'); assert.equal(users(fixture).length, 3);
  r.draft = 'hold queued work';
  wire.emit({ type: 'result', subtype: 'success', user_message_uuids: [second], result: 'Latest guidance answer' });
  assert.equal(r.snapshot().status, 'ready'); assert.equal(r.protocol.state.turns.length, 1);
  await r.pending.drain(); assert.equal(users(fixture).length, 3); assert.equal(r.pending.queue.length, 1);
});

test('Claude guidance rejects stale turns, pending approvals, compaction and unavailable runtime versions', async t => {
  const { r, fixture, wire } = await setup(t);
  const version = r.protocol.initialization.claude_code_version;
  r.submit('approve'); await assert.rejects(r.steering.steer('guide', turn(r), randomUUID()), /changed or is waiting/);
  r.answer(r.snapshot().requests[0].id, 'deny');
  r.submit('slow'); await assert.rejects(r.steering.steer('guide', randomUUID(), randomUUID()), /changed or is waiting/);
  r.protocol.state.turns.at(-1).kind = 'compact'; await assert.rejects(r.steering.steer('guide', turn(r), randomUUID()), /changed or is waiting/);
  delete r.protocol.state.turns.at(-1).kind; r.protocol.initialization.claude_code_version = '2.1.285';
  assert.equal(r.snapshot().supportsSteer, false); await assert.rejects(r.steering.steer('guide', turn(r), randomUUID()), /changed or is waiting/);
  assert.equal(users(fixture).filter(call => call.priority === 'now').length, 0);
  r.protocol.initialization.claude_code_version = version;
  wire.complete();
  const priorUsers = users(fixture).length;
  r.submit('slow'); r.draft = 'keep me';
  const input = r.composer.input.bind(r.composer);
  r.composer.input = async (...args) => { const result = await input(...args); wire.complete(); return result; };
  await assert.rejects(r.steering.steer(r.draft, turn(r), randomUUID()), /changed or is waiting/);
  assert.equal(r.draft, 'keep me'); assert.equal(users(fixture).length, priorUsers + 1);
  r.composer.input = input; r.submit('slow'); r.draft = 'keep me too';
  const save = r.pending.save.bind(r.pending); let once = true;
  r.pending.save = async () => { await save(); if (once) { once = false; wire.complete(); } };
  const id = randomUUID(); await assert.rejects(r.steering.steer(r.draft, turn(r), id), /changed or is waiting/);
  assert.equal(r.draft, 'keep me too'); assert.equal(users(fixture).length, priorUsers + 2); assert.equal(r.steering.operation.status, 'cancelled');
  assert.equal((await r.steering.steer('keep me too', turn(r), id)).steered, false);
});

test('Claude guidance uncertain delivery survives restart without replay; explicit review unlocks sending', async t => {
  const { r, fixture, create } = await setup(t, { holdSteerResult: true });
  r.submit('slow'); const id = randomUUID(); await r.steering.steer('guide', turn(r), id);
  await r.persistState(); await r.close();
  const resumed = create(); t.after(() => resumed.close()); await resumed.start();
  assert.equal(resumed.protocol.state.uncertain, true); assert.equal(resumed.steering.operation.status, 'uncertain');
  const before = users(fixture).length; const result = await resumed.steering.steer('guide', turn(resumed), id);
  assert.equal(result.status, 'uncertain'); assert.equal(users(fixture).length, before);
  await resumed.acknowledgeUncertain(); resumed.submit('after review'); assert.equal(users(fixture).length, before + 1);
});

test('Claude guidance refuses dispatch when its receipt cannot be saved', async t => {
  const { r, fixture } = await setup(t);
  r.submit('slow'); r.draft = 'keep unsent guidance';
  r.pending.save = async () => { throw new Error('Synthetic disk failure'); };
  await assert.rejects(r.steering.steer(r.draft, turn(r), randomUUID()), /disk failure/);
  assert.equal(users(fixture).length, 1); assert.equal(r.draft, 'keep unsent guidance');
  assert.deepEqual(r.steering.receipts, []); assert.equal(r.steering.operation, null);
});
