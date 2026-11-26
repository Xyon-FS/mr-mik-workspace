import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from './fixtures.mjs';
import { readFile } from 'node:fs/promises';
import { OpenCodeMessageActions } from '../opencode-message-actions.mjs';
import { providerMessageReceipt } from '../provider-message-receipts.mjs';
const revision = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
function fixture() {
  const messages = [{ id: 'msg_input', type: 'user', text: 'Synthetic', time: { created: 1 } }, { id: 'msg_answer', type: 'assistant', agent: 'build', model: { providerID: 'fixture', id: 'test' }, content: [{ type: 'text', text: 'Answer' }], time: { created: 2, completed: 3 } }];
  const source = { id: 'source', agent: 'opencode', cwd: 'synthetic', status: 'running', activity: 'idle', nativeId: 'ses_source', process: {}, openCodeLaunchId: 'launch' }, calls = [];
  const actions = new OpenCodeMessageActions({}, { command: async (...input) => { calls.push(input); return { nativeId: 'ses_fork' }; } }, {});
  actions.store = () => ({ read: async id => ({ messages: id === 'ses_fork' ? structuredClone(messages) : messages }) });
  const request = { kind: 'retry', itemId: 'msg_answer', launchId: 'launch', revision: revision(messages) };
  return { actions, source, messages, calls, request };
}
test('OpenCode message actions reject unknown/stale boundaries before calling the native fork', async () => {
  const f = fixture();
  await assert.rejects(f.actions.execute(f.source, { ...f.request, itemId: 'msg_missing' }, async () => {}), /matching input/);
  await assert.rejects(f.actions.execute(f.source, { ...f.request, revision: 'stale' }, async () => {}), /history changed/);
  await assert.rejects(f.actions.execute(f.source, { ...f.request, launchId: 'stale' }, async () => {}), /connection changed/);
  assert.equal(f.calls.length, 0);
  f.messages[0].files = [{ data: 'AQID' }]; f.request.revision = revision(f.messages);
  await assert.rejects(f.actions.execute(f.source, f.request, async () => {}), /attachments/);
  delete f.messages[0].files; f.messages[0].skills = ['native-skill']; f.request.revision = revision(f.messages);
  await assert.rejects(f.actions.execute(f.source, f.request, async () => {}), /special context/);
  delete f.messages[0].skills; delete f.messages[1].time.completed; f.request.revision = revision(f.messages);
  await assert.rejects(f.actions.execute(f.source, f.request, async () => {}), /settled/); assert.equal(f.calls.length, 0);
});

test('OpenCode stale preflight can recover with the same request ID while a native fork failure stays reserved', async () => {
  const f = fixture(), stateDir = await mkdtemp(path.join(os.tmpdir(), 'mik-opencode-action-preflight-'));
  const request = { ...f.request, requestId: randomUUID(), launchId: 'stale' };
  const run = () => providerMessageReceipt({ sessions: { stateDir }, source: f.source, request,
    prepare: () => f.actions.prepare?.(f.source, request),
    execute: record => f.actions.execute(f.source, request, record, value => value) });
  await assert.rejects(run(), /connection changed/); assert.equal(f.calls.length, 0);
  request.launchId = f.source.openCodeLaunchId;
  // The fixture intentionally returns a full-copy fork for a bounded retry.
  await assert.rejects(run(), /boundary could not be confirmed/);
  assert.deepEqual(f.calls, [['source', 'message-fork', { before: 'msg_input' }]]);
  const receipt = JSON.parse(await readFile(path.join(stateDir, 'message-action-source-' + request.requestId + '.json'), 'utf8'));
  assert.equal(receipt.stage, 'native-fork');
  assert.equal(receipt.nativeId, 'ses_fork');
  await assert.rejects(run(), /boundary could not be confirmed/); assert.equal(f.calls.length, 1);
  f.source.providerMessageReceipts.clear();
  await assert.rejects(run(), /already reserved/); assert.equal(f.calls.length, 1);
});
test('OpenCode native history search uses full text, exact IDs and bounded pages', async () => {
  const f = fixture();
  f.messages.splice(0, f.messages.length, ...Array.from({ length: 230 }, (_, index) => ({ id: `msg_${index}`, type: 'user', text: `${'prefix '.repeat(40)}${index === 2 ? 'old-needle' : 'Other input'} ${index}` })));
  let reads = 0;
  const store = f.actions.store();
  f.actions.store = () => ({ read: async id => {
    if (++reads === 1) throw new Error('Native V2 export was not recognized.');
    return store.read(id);
  } });
  const latest = await f.actions.list(f.source); assert.equal(latest.messages.length, 100); assert.equal(latest.total, 230); assert.equal(latest.hasMore, true);
  assert.equal(reads, 2); assert.equal(f.calls.length, 0);
  const older = await f.actions.list(f.source, { offset: 100 }); assert.ok(!older.messages.some(message => latest.messages.some(row => row.id === message.id)));
  const result = await f.actions.list(f.source, { query: 'old-needle' }); assert.equal(result.messages[0].id, 'msg_2'); assert.match(result.messages[0].preview, /old-needle/); assert.equal(result.total, 1);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.actions.list(f.source, { offset: -1 }), /Invalid native/);
});
