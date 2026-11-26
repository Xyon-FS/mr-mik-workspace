import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { PortableArchive } from '../portable-archive.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-queue-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: root, agent: 'claude', effort: 'low' };
  const fixture = claudeFixture(session.nativeId, { commands: [{ name: 'compact', builtin: true }, { name: 'test-skill' }] });
  const create = () => new ClaudeChat({ session, stateDir: root, transportFactory: fixture.factory });
  const runtime = create(); await runtime.start();
  t.after(async () => { await runtime.close(); fixture.close(); });
  return { runtime, fixture, root, create };
}
const users = fixture => fixture.calls.filter(call => call.type === 'user');
async function wait(check) {
  for (let index = 0; index < 200; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Queue did not reach expected state');
}

test('Claude queue waits for completion, preserves drafts, sends sequentially and deduplicates receipts', async t => {
  const { runtime: r, fixture } = await setup(t);
  r.submit('slow'); r.draft = 'next'; const id = randomUUID();
  await r.pending.enqueue('next', id); await r.pending.enqueue('next', id);
  assert.equal(users(fixture).length, 1); assert.equal(r.draft, ''); assert.equal(r.ready(), false);
  await r.pending.enqueue('third', randomUUID());
  r.draft = 'still editing'; fixture.transports.values().next().value.complete();
  await r.pending.drain(); assert.equal(users(fixture).length, 1);
  r.draft = ''; r.changed(); await wait(() => users(fixture).length === 3 && !r.pending.pending);
  assert.deepEqual(users(fixture).map(call => call.message.content[0].text), ['slow', 'next', 'third']);
  await r.pending.enqueue('next', id); assert.equal(users(fixture).length, 3);
  assert.equal(r.protocol.state.sessionId, r.session.nativeId);
});

test('Claude queue never answers approvals; interruption pauses remaining work', async t => {
  const { runtime: r, fixture } = await setup(t);
  r.submit('approve'); await r.pending.enqueue('later', randomUUID());
  await r.pending.drain(); assert.equal(users(fixture).length, 1);
  assert.equal(fixture.calls.filter(call => call.type === 'control_response').length, 0);
  await r.interrupt(); assert.equal(r.pending.paused, true);
  await r.pending.drain(); assert.equal(users(fixture).length, 1);
  r.pending.pause(false); await wait(() => users(fixture).length === 2);
});

test('Claude queue revalidates attachments, keeps invalid entries unsent and includes selected context', async t => {
  const { runtime: r, fixture, root } = await setup(t);
  r.pending.pause(true);
  const file = path.join(root, 'pixel.png'), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await writeFile(file, png);
  await r.attach([file]);
  await r.composer.add({ type: 'skill', name: 'test-skill', path: 'native:test-skill' });
  await assert.rejects(r.pending.enqueue('inspect', randomUUID()), /combined with images/);
  assert.equal(r.attachments.length, 1);
  assert.equal(r.composer.items.length, 1);
  assert.equal(users(fixture).length, 0);
  r.composer.restore([]);
  await r.pending.enqueue('image', randomUUID());
  await writeFile(file, Buffer.concat([png, Buffer.from('changed')]));
  r.pending.pause(false); await r.pending.drain();
  assert.equal(r.pending.paused, true); assert.equal(users(fixture).length, 0);
  assert.equal(r.pending.queue[0].state, 'queued'); assert.match(r.pending.notice, /changed since selection/);
  await r.pending.cancel(r.pending.queue[0].id);
  r.composer.restore([{ id: randomUUID(), type: 'quote', itemId: 'source', role: 'assistant', text: 'selected excerpt' }]);
  await r.pending.enqueue('context', randomUUID()); r.pending.pause(false);
  await wait(() => users(fixture).length === 1);
  assert.match(users(fixture)[0].message.content[0].text, /selected excerpt/);
  assert.equal(r.composer.items.length, 0);
  assert.doesNotMatch(await readFile(r.pending.file, 'utf8'), new RegExp(png.toString('base64')));
});

test('Claude queue persists reservation before wire send and never replays uncertain delivery after restart', async t => {
  const { runtime: r, fixture, root, create } = await setup(t);
  r.pending.pause(true); const id = randomUUID(); await r.pending.enqueue('uncertain', id);
  const original = r.protocol.submit.bind(r.protocol);
  let reservation;
  r.protocol.submit = (...args) => {
    reservation = readFileSync(r.pending.file);
    original(...args);
    throw new Error('Lost acknowledgment');
  };
  r.pending.pause(false); await r.pending.drain();
  assert.equal(JSON.parse(reservation).queue[0].state, 'sending'); assert.equal(users(fixture).length, 1); assert.equal(r.pending.queue[0].state, 'uncertain');
  const stored = JSON.parse(await readFile(r.pending.file, 'utf8')); assert.equal(stored.queue[0].state, 'uncertain');
  await r.persistState(); await r.close();
  await writeFile(r.pending.file, reservation);
  const restored = create(); t.after(() => restored.close()); await restored.start();
  assert.equal(restored.pending.queue[0].state, 'uncertain'); assert.throws(() => restored.pending.pause(false), /uncertain/);
  await restored.pending.enqueue('uncertain', id); assert.equal(users(fixture).length, 1);
  assert.equal(restored.pending.queue[0].state, 'uncertain');
  const destination = await mkdtemp(path.join(os.tmpdir(), 'mik-queue-export-'));
  const archive = new PortableArchive(root, root, { list: () => [{ ...r.session, open: false }] });
  await assert.rejects(archive.exportTo(destination, { chats: 'light' }), /Finish or remove pending Claude queue/);
  await restored.pending.cancel(id); restored.pending.pause(false); await restored.pending.drain(); assert.equal(users(fixture).length, 1);
});

test('Claude queue rechecks pause and draft edits after durable reservation, before wire send', async t => {
  const { runtime: r, fixture } = await setup(t);
  const save = r.pending.save.bind(r.pending);
  r.draft = 'preserve'; r.pending.save = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(r.pending.enqueue('preserve', randomUUID()), /Disk unavailable/);
  assert.equal(r.draft, 'preserve'); assert.equal(r.pending.queue.length, 0); assert.equal(users(fixture).length, 0);
  r.pending.save = save;
  r.draft = '';
  r.pending.pause(true); await r.pending.enqueue('queued', randomUUID());
  let reserved = false;
  r.pending.save = async () => {
    await save();
    if (r.pending.queue[0]?.state === 'sending') { reserved = true; r.draft = 'new draft during reservation'; r.pending.pause(true); }
  };
  r.pending.pause(false); await r.pending.drain();
  assert.equal(reserved, true); assert.equal(users(fixture).length, 0); assert.equal(r.pending.queue[0].state, 'queued');
  assert.equal(r.draft, 'new draft during reservation');
});
