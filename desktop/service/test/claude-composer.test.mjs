import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-context-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: root }, transports = [];
  const create = () => { const wire = claudeFixture(session.nativeId, { commands: [{ name: 'fixture-skill', description: 'Fixture skill (project)' }, { name: 'other-skill' }, { name: 'compact', builtin: true }, { name: 'dangerous', builtin: true }] }); transports.push(wire); return new ClaudeChat({ session, stateDir: root, transportFactory: wire.factory }); };
  const runtime = create(); await runtime.start();
  t.after(async () => { await runtime.close(); transports.forEach(wire => wire.close()); });
  return { runtime, root, create, session, calls: () => transports.flatMap(wire => wire.calls).filter(message => message.type === 'user') };
}
test('Claude quotes are inspectable context from this chat and consumed once with the selected native skill', async t => {
  const { runtime: r, calls, root } = await fixture(t); r.submit('First synthetic input');
  const response = r.snapshot().items.find(item => item.type === 'agentMessage');
  r.loadedHistory.set('formatted-source', { id: 'formatted-source', type: 'agentMessage', text: 'Read **this** [note](https://example.invalid).' });
  await r.composer.add({ type: 'quote', itemId: 'formatted-source', text: 'Read this note.' });
  assert.equal(r.composer.items[0].text, 'Read this note.');
  r.composer.remove(r.composer.items[0].id);
  await r.composer.add({ type: 'quote', itemId: response.id, text: 'Claude answer.' });
  await assert.rejects(r.composer.add({ type: 'quote', itemId: response.id, text: 'Invented quote' }), /select text/);
  await assert.rejects(r.composer.add({ type: 'quote', itemId: 'other-chat' }), /select text/);
  const quote = r.composer.items[0], source = await r.composer.source(quote.id); assert.equal(source.anchorId, response.id);
  await r.composer.add({ type: 'skill', name: 'fixture-skill', path: 'native:fixture-skill' });
  r.draft = 'Review the selected quote';
  const commands = r.protocol.initialization.commands;
  r.protocol.initialization.commands = [];
  await assert.rejects(r.submit(), /no longer available/); assert.equal(calls().length, 1); assert.equal(r.draft, 'Review the selected quote'); assert.equal(r.composer.items.length, 2);
  r.protocol.initialization.commands = commands;
  const file = path.join(root, 'image.png'); await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await r.attach([file]); await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('changed')]));
  await assert.rejects(r.submit(), /does not expand.*images/); assert.equal(calls().length, 1); assert.equal(r.composer.items.length, 2);
  r.detach(file);
  await r.submit();
  assert.equal(calls().length, 2); assert.match(calls()[1].message.content[0].text, /^\/fixture-skill Review/); assert.match(calls()[1].message.content[0].text, /> Claude answer\./);
  assert.equal(r.composer.items.length, 0); assert.equal(r.draft, '');
  const input = r.snapshot().items.filter(item => item.type === 'userMessage').at(-1); assert.equal(input.text, 'Review the selected quote'); assert.equal(input.composerContext.length, 2);
});
