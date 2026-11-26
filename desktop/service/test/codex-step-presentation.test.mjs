import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from './fixtures.mjs';
import { projectChatItem } from '../codex-chat-items.mjs';
import { structuredPreview } from '../chat-step-presentation.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
test('structured output keeps bounded valid previews and preserves the original recording', () => {
  for (const sample of [Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['field' + i, 'x'.repeat(1000)])), { value: '\u0000'.repeat(10000), token: 'PRIVATE' }, Array.from({ length: 500 }, () => ({ nested: 'value'.repeat(500) }))]) {
    const preview = structuredPreview(sample);
    assert.equal(preview.truncated, true); assert.ok(preview.text.length <= 16000); assert.doesNotThrow(() => JSON.parse(preview.text)); assert.doesNotMatch(preview.text, /PRIVATE/);
  }
  assert.deepEqual(structuredPreview({ count: 1 }), { text: '{\n  "count": 1\n}', truncated: false });
  const common = 'path-component-'.repeat(20);
  const tails = structuredPreview({ [common + 'first.txt']: 'First value', [common + 'second.txt']: 'Second value' });
  assert.deepEqual(Object.values(JSON.parse(tails.text)), ['First value', 'Second value']);
  assert.match(tails.text, /first\.txt/); assert.match(tails.text, /second\.txt/);
  const collisions = structuredPreview({ [common + 'one' + common]: 1, [common + 'two' + common]: 2 });
  assert.deepEqual(Object.values(JSON.parse(collisions.text)), [1, 2]); assert.equal(collisions.truncated, true);

  for (const size of [32000, 32001]) {
    const text = 'x'.repeat(size), result = projectChatItem({ id: 'large', type: 'mcpToolCall', result: { content: [{ type: 'text', text }], structuredContent: { token: 'PRIVATE' } } });
    assert.equal(result.presentation.resultTextLength, size); assert.equal(result.presentation.resultTextTruncated, size > 32000);
    assert.equal(result.fullDetails.slice(0, result.presentation.resultTextLength), text);
    assert.match(result.fullDetails, /PRIVATE/); // The original recording isn't mutated.
    assert.doesNotMatch(result.presentation.structured, /PRIVATE/);
  }
  const media = projectChatItem({ id: 'media', type: 'mcpToolCall', result: { content: [{ type: 'resource', resource: { name: 'Report', text: 'Resource body', mimeType: 'text/plain' } }] } });
  assert.equal(media.presentation.resultText, ''); assert.equal(media.resources[0].text, 'Resource body');
});
test('native plan deltas update stable items and completed content is authoritative', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-step-stream-')), wire = graphicalFixture();
  const runtime = new CodexChat({ session: { cwd: root }, env: { CODEX_HOME: root }, spawnChild: wire.spawnChild });
  t.after(async () => { await runtime.close(); for (const child of wire.children) child.kill(); }); await runtime.start();
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, turnId: 'turn', ...params } });
  notify('item/plan/delta', { itemId: 'plan', delta: '# Proposed' }); notify('item/plan/delta', { itemId: 'plan', delta: '\n1. Inspect' });
  assert.equal(runtime.items.get('plan').text, '# Proposed\n1. Inspect');
  notify('item/completed', { item: { id: 'plan', type: 'plan', text: 'Authoritative plan' } });
  assert.equal(runtime.items.get('plan').text, 'Authoritative plan'); assert.equal(runtime.items.size, 1);
  for (let n = 0; n < 2; n++) notify('turn/plan/updated', { plan: [{ step: 'Inspect', status: n ? 'completed' : 'inProgress' }] });
  assert.equal(runtime.items.size, 2); assert.equal(runtime.items.get('plan-turn').plan[0].status, 'completed');
  assert.ok(!wire.calls.some(call => call.method === 'turn/start'));
});
