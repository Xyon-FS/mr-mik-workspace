import test from 'node:test';
import assert from 'node:assert/strict';
import { elicitationFields, validateElicitation } from '../elicitation-schema.mjs';
import { projectChatItem } from '../codex-chat-items.mjs';
import { resultBytes, projectResultContent } from '../chat-result-content.mjs';
import { CodexChat } from '../codex-chat.mjs';

const schema = { type: 'object', required: ['name', 'count', 'confirm'], properties: { name: { type: 'string', minLength: 2 }, count: { type: 'integer', minimum: 1, maximum: 5 }, confirm: { type: 'boolean' }, choice: { type: 'string', oneOf: [{ const: 'a', title: 'Alpha' }] }, tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, minItems: 1 } } };
test('MCP forms validate types, required false, limits and enum choices without coercion', () => {
  const valid = { name: 'Test', count: 2, confirm: false, choice: 'a', tags: ['x'] };
  assert.equal(validateElicitation(schema, valid).valid, true);
  for (const invalid of [{ ...valid, count: '2' }, { ...valid, count: 2.5 }, { ...valid, confirm: undefined }, { ...valid, choice: 'z' }, { ...valid, tags: ['x', 'x'] }, { ...valid, name: '' }, { ...valid, other: true }]) assert.equal(validateElicitation(schema, invalid).valid, false);
  assert.equal(validateElicitation(schema, { name: 'Ok', count: 1, confirm: false }).valid, true);
  assert.ok(elicitationFields({ type: 'object', properties: { nested: { type: 'object' } } }).error);
  assert.ok(elicitationFields({ type: 'object', properties: { value: { type: 'string', pattern: 'x' } } }).error);
});
test('invalid/unsupported elicitation answers send nothing; valid responses are single-use and cancellation remains available', () => {
  const runtime = new CodexChat({ session: {} }), sent = []; runtime.send = value => sent.push(value); runtime.changed = () => {};
  runtime.requests.set('1', { nativeId: 1, supported: true, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: schema } });
  assert.throws(() => runtime.answer('1', 'accept', {}), /required/); assert.equal(sent.length, 0);
  runtime.answer('1', 'accept', { name: 'Ok', count: 1, confirm: false }); assert.equal(sent[0].result.content.confirm, false);
  assert.throws(() => runtime.answer('1', 'accept', {}), /already/);
  runtime.requests.set('2', { nativeId: 2, supported: true, method: 'mcpServer/elicitation/request', params: { mode: 'form', requestedSchema: {} } });
  assert.throws(() => runtime.answer('2', 'accept', {}), /unsupported/); runtime.answer('2', 'cancel'); assert.equal(sent.at(-1).result.content, null);
});
test('typed tool assets do not expose binary payloads in snapshots or execute HTML', async () => {
  const item = { id: 'media', type: 'mcpToolCall', result: { content: [{ type: 'audio', mimeType: 'audio/wav', data: Buffer.from('synthetic').toString('base64') }, { type: 'resource', resource: { uri: 'tool://html', mimeType: 'text/html', text: '<script>test</script>' } }, { type: 'resource_link', uri: 'https://example.invalid/file', name: 'External' }, { type: 'unknown' }] } };
  const projection = projectChatItem(item);
  assert.deepEqual(projection.resources.map(value => value.kind), ['audio', 'text', 'link', 'unsupported']);
  assert.equal(resultBytes(projection.fullResources[0], true).mimeType, 'audio/wav');
  assert.throws(() => resultBytes(projection.fullResources[1], true), /no supported/);
  const runtime = new CodexChat({ session: {} }); runtime.upsert(item);
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /c3ludGhldGlj|fullResources/);
  assert.equal(runtime.resultAssets.get('media')[0].data, Buffer.from('synthetic').toString('base64'));
  const result = projectResultContent({ contentItems: [{ type: 'inputText', text: 'Caption' }, { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AA==' }] });
  assert.match(result.summary, /Caption/); assert.equal(result.assets[0].kind, 'audio');
  await runtime.close(); assert.equal(runtime.resultAssets.size, 0);
});
