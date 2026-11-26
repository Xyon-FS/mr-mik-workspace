import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { Sessions } from '../sessions.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-composer-')), transport = graphicalFixture({ completeBeforeResponse: true });
  const runtime = new CodexChat({ session: { cwd: root }, spawnChild: transport.spawnChild });
  t.after(() => runtime.close()); await runtime.start();
  let enabled = true;
  const skill = { name: 'fixture-skill', path: path.join(root, 'SKILL.md'), description: 'Synthetic skill' }, rpc = runtime.rpc.bind(runtime);
  runtime.rpc = (method, params) => method === 'skills/list' ? Promise.resolve({ data: [{ cwd: root, skills: [{ ...skill, enabled }] }] }) : rpc(method, params);
  runtime.upsert({ id: 'source', type: 'agentMessage', text: 'Quote this selected sentence.' });
  return { root, runtime, transport, skill, disable: () => { enabled = false; }, enable: () => { enabled = true; } };
}
test('composer rejects stale or oversized context and consumes valid quotes and skills on acknowledgement', async t => {
  const { runtime: r, transport, skill, disable, enable } = await fixture(t);
  await r.composer.add({ type: 'skill', ...skill }); disable(); r.draft = 'Keep draft';
  await assert.rejects(r.submit(), /no longer available/); assert.equal(r.uncertain, false); assert.equal(r.draft, 'Keep draft'); assert.equal(r.composer.items.length, 1);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
  r.composer.remove(r.composer.items[0].id);
  await r.composer.add({ type: 'quote', itemId: 'source', text: 'x'.repeat(8000) });
  await assert.rejects(r.submit('a'.repeat(64000)), /exceed/); assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
  r.composer.remove(r.composer.items[0].id);
  enable();
  await assert.rejects(r.composer.add({ type: 'quote', itemId: 'not-loaded', text: 'Hidden' }), /Load the source/);
  await r.composer.add({ type: 'quote', itemId: 'source', text: 'selected sentence' });
  await r.composer.add({ type: 'quote', itemId: 'source', text: 'selected sentence' }); assert.equal(r.composer.items.length, 1);
  await r.composer.add({ type: 'skill', ...skill });
  r.draft = 'Use this context'; await r.submit();
  const input = transport.calls.find(call => call.method === 'turn/start').params.input;
  assert.match(input[0].text, /assistant message source/); assert.match(input[0].text, /> selected sentence/);
  assert.deepEqual(input.at(-1), { type: 'skill', name: skill.name, path: skill.path });
  assert.equal(r.composer.items.length, 0);
});
test('composer context and private pasted files survive orderly restart without leaking into the session index', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-composer-state-')), state = path.join(root, 'state'), transport = graphicalFixture();
  const open = async () => {
    const sessions = await new Sessions(root, state).init();
    sessions.accountContext = async () => ({ profileId: 'fixture', sqliteHome: path.join(root, 'sqlite'), env: { ...process.env, CODEX_HOME: root } });
    sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild }); return sessions;
  };
  await mkdir(path.join(root, 'sqlite')); const first = await open(); t.after(() => first.close());
  const chat = await first.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'fixture', cwd: root }), r = first.get(chat.id).graphical;
  r.upsert({ id: 'private-source', type: 'agentMessage', text: 'Private quotation' }); await r.composer.add({ type: 'quote', itemId: 'private-source' });
  const paste = await r.composer.paste(state, chat.id, 'private pasted content'); assert.equal(await readFile(paste.path, 'utf8'), 'private pasted content');
  await assert.rejects(r.composer.paste(state, chat.id, 'x'.repeat(256001)), /smaller/);
  await first.close(); assert.doesNotMatch(await readFile(path.join(state, 'sessions.json'), 'utf8'), /Private quotation|private pasted content/);
  const second = await open(); t.after(() => second.close()); await second.resume(chat.id);
  const restored = second.get(chat.id).graphical;
  assert.equal(restored.composer.items[0].text, 'Private quotation'); assert.deepEqual(restored.attachments, [paste.path]);
  assert.equal(restored.ready(), false); assert.equal(await readFile(paste.path, 'utf8'), 'private pasted content');
});
