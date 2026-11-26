import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicalComposer } from '../graphical-composer.mjs';
import { ClaudeComposer } from '../claude-composer.mjs';
for (const Composer of [GraphicalComposer, ClaudeComposer]) test(`${Composer.name} browser notes retain provenance and newer edits survive an older acknowledged send`, async () => {
  const runtime = { draftRevision: 0, changed() {}, assertAttachmentReady() {} }, composer = new Composer(runtime);
  composer.addBrowser({ url: 'https://example.test/page', title: 'Example', text: 'Selected text' });
  const sent = structuredClone(composer.items), oldId = sent[0].id;
  composer.editBrowser(oldId, 'A newer edited note'); assert.notEqual(composer.items[0].id, oldId);
  composer.consumed(sent); assert.equal(composer.items[0].text, 'A newer edited note');
  composer.restore(structuredClone(composer.items)); assert.equal(composer.items[0].sourceUrl, 'https://example.test/page');
  assert.match(JSON.stringify(await composer.input('Question', [], composer.items)), /A newer edited note/);
  assert.throws(() => composer.addBrowser({ url: 'file:///private', text: 'No' }), /Invalid browser source/);
  assert.throws(() => composer.editBrowser(composer.items[0].id, 'x'.repeat(8001)), /shorter browser note/);
});
