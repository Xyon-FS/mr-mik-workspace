import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { writeClaudeHistory } from './claude-history-fixture.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { projectClaudeHistory } from '../claude-history-projection.mjs';
import { prepareClaudeMessageAction } from '../claude-message-actions.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-native-history-')), cwd = path.join(root, 'relocated'), config = path.join(root, 'profile'); await mkdir(cwd);
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd, hasConversation: true };
  const native = await writeClaudeHistory(config, path.join(root, 'original'), session.nativeId);
  const wire = claudeFixture(session.nativeId), runtime = new ClaudeChat({ session, stateDir: cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, transportFactory: wire.factory });
  t.after(() => runtime.close()); await runtime.start(session.nativeId);
  return { ...native, runtime, wire, config, root };
}
test('Claude opens CLI history in a relocated Hub and pages exact IDs without inference or duplicates', async t => {
  const { runtime, wire, rows, file, config } = await fixture(t), original = await readFile(file, 'utf8');
  assert.equal(runtime.snapshot().items.length, 100); assert.equal(runtime.snapshot().hasOlder, true);
  const ids = new Set(runtime.snapshot().items.map(item => item.id)); let beforeId = runtime.snapshot().items[0].id;
  for (;;) {
    const page = await runtime.older({ beforeId });
    for (const item of page.items) { assert.ok(!ids.has(item.id)); ids.add(item.id); }
    if (!page.hasOlder) break;
    beforeId = page.nextCursor;
  }
  assert.equal(ids.size, rows.length); assert.equal(wire.calls.filter(item => item.type === 'user').length, 0);
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(runtime.older({ beforeId: 'missing' }), /could not be verified/);
  const duplicate = path.join(config, 'projects', 'duplicate');
  await mkdir(duplicate);
  await copyFile(file, path.join(duplicate, path.basename(file)));
  await assert.rejects(runtime.history.page(), /could not be verified/);
  await runtime.close(); assert.equal(runtime.protocol.state.uncertain, false);
});
test('Claude full native search finds older messages, reveals context, and refuses stale/superseded results', async t => {
  const { runtime, file } = await fixture(t);
  let result = await runtime.historySearch.search({ query: 'ancient-needle' });
  while (!result.complete && !result.results.length) result = await runtime.historySearch.search({ query: result.query, searchId: result.searchId });
  assert.equal(result.results.length, 1);
  const page = await runtime.historySearch.open({ searchId: result.searchId, itemId: result.results[0].id });
  assert.ok(page.items.some(item => item.text.includes('ancient-needle'))); assert.equal(page.runtimeId, runtime.runtimeId);
  const plan = await prepareClaudeMessageAction(runtime, page.items.find(item => item.type === 'agentMessage').id, 'branch'); assert.ok(plan.anchor);
  await writeFile(file, (await readFile(file, 'utf8')).replace('Input 0', 'Changed 0'));
  await assert.rejects(runtime.historySearch.open({ searchId: result.searchId, itemId: result.results[0].id }), /could not be verified/);
  await runtime.historySearch.search({ query: 'Response' });
  await assert.rejects(runtime.historySearch.open({ searchId: result.searchId, itemId: result.results[0].id }), /expired|changed/);
  await writeFile(file, (await readFile(file, 'utf8')).replace('Response 179', 'x'.repeat(250000) + ' tail-needle'));
  const tailResult = await runtime.historySearch.search({ query: 'tail-needle' });
  assert.equal(tailResult.results.length, 1);
  const tailPage = await runtime.historySearch.open({ searchId: tailResult.searchId, itemId: tailResult.results[0].id });
  assert.match(tailPage.items.find(item => item.id === tailPage.anchorId).text, /tail-needle/);
});
test('Claude native projection excludes image payloads, signatures and binary tool results', () => {
  const result = projectClaudeHistory([
    { type: 'user', uuid: 'input', message: { content: [{ type: 'image', source: { data: 'NEVER_IMAGE' } }, { type: 'text', text: 'Visible' }] } },
    { type: 'assistant', uuid: 'answer', message: { id: 'answer', content: [{ type: 'thinking', thinking: 'Reasoning', signature: 'NEVER_SIGNATURE' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { data: 'NEVER_INPUT', path: 'file.txt' } }] } },
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'image', source: { data: 'NEVER_RESULT' } }, { type: 'text', text: 'Tool text' }] }] } },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_/); assert.match(result.items[0].text, /unavailable/); assert.match(result.items.at(-1).text, /Tool text/);
});
