import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

async function fixture(t, count = 600) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-history-search-')), transport = graphicalFixture();
  const runtime = new CodexChat({ session: { cwd: root }, spawnChild: transport.spawnChild });
  t.after(() => runtime.close()); await runtime.start(); runtime.draft = 'Keep this unsent draft';
  const all = Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, type: 'agentMessage', text: `Message ${index}`, status: 'completed' }));
  transport.history.set(runtime.threadId, all); for (const item of all) runtime.upsert(item);
  return { runtime, transport, all };
}
test('paginated search reports partial coverage, resumes without gaps and opens its exact native page', async t => {
  const { runtime: r, transport, all } = await fixture(t, 1000); all[13].text = 'Very old unique marker'; r.historyMode = 'paginated';
  const entries = all.map(item => ({ item, turnId: 'old-turn' })).reverse(), calls = [];
  r.rpc = async (method, params) => { assert.equal(method, 'thread/items/list'); assert.equal(params.threadId, r.threadId); calls.push(params); const start = Number(params.cursor || 0); return { data: entries.slice(start, start + 100), nextCursor: start + 100 < entries.length ? String(start + 100) : null }; };
  let page = await r.historySearch.search({ query: 'unique marker' }); assert.equal(page.complete, false); assert.equal(page.results.length, 0); assert.equal(calls.length, 3);
  while (page.hasMore) page = await r.historySearch.search({ query: 'unique marker', searchId: page.searchId });
  assert.equal(page.results[0].id, 'item-13'); assert.equal(page.scanned, 1000);
  const window = await r.historySearch.open({ searchId: page.searchId, itemId: 'item-13' });
  assert.equal(calls.at(-1).cursor, '900'); assert.ok(window.items.some(item => item.id === 'item-13')); assert.ok(r.items.size <= 150); assert.ok(r.historyItems.size <= 250);
  r.draft = 'Keep this unsent draft';
  await r.historySearch.search({ query: 'nothing' });
  await assert.rejects(r.historySearch.open({ searchId: page.searchId, itemId: 'item-13' }), /expired/);
  const fresh = await r.historySearch.search({ query: 'Message' });
  await assert.rejects(r.historySearch.open({ searchId: fresh.searchId, itemId: 'not-a-result' }), /no longer available/);
  r.historyMode = 'paginated'; r.rpc = async method => { assert.equal(method, 'thread/items/list'); return { data: [], nextCursor: 'repeated' }; };
  await assert.rejects(r.historySearch.search({ query: 'missing' }), /repeated/);
  await assert.rejects(r.historySearch.search({ query: 'x'.repeat(201) }), /200/);
  r.rpc = async () => { throw new Error('Saved history unavailable'); };
  await assert.rejects(r.historySearch.search({ query: 'unavailable' }), /unavailable/);
  assert.equal(r.historySearch.job.complete, false);
  assert.equal(r.draft, 'Keep this unsent draft');
  r.historySearch.clear();
  assert.equal(r.historySearch.job, null);
  const privacyEntries = [
    { id: 'reason', type: 'reasoning', content: [{ text: 'PRIVATE_INTERNAL_MARKER' }], summary: [{ text: 'Public summary' }] },
    { id: 'tool', type: 'commandExecution', aggregatedOutput: 'x'.repeat(50000) + ' late-output-marker', status: 'completed' },
    { id: 'binary', type: 'mcpToolCall', result: { content: [{ type: 'image', mimeType: 'image/png', data: 'BINARY_BODY_MARKER' }] } },
  ];
  transport.history.set(r.threadId, privacyEntries); r.historyMode = 'paginated'; r.rpc = async () => ({ data: privacyEntries, nextCursor: null });
  assert.equal((await r.historySearch.search({ query: 'PRIVATE_INTERNAL_MARKER' })).results.length, 0);
  assert.equal((await r.historySearch.search({ query: 'BINARY_BODY_MARKER' })).results.length, 0);
  assert.equal((await r.historySearch.search({ query: 'Public summary', limit: 1 })).results[0].id, 'reason');
  assert.doesNotMatch(JSON.stringify(r.historySearch.job.buffer), /PRIVATE_INTERNAL_MARKER|BINARY_BODY_MARKER/);
  const found = await r.historySearch.search({ query: 'late-output-marker' }); assert.equal(found.results[0].id, 'tool');
  await r.historySearch.open({ searchId: found.searchId, itemId: 'tool' }); assert.ok(r.outputs.get('tool').includes('late-output-marker')); assert.equal(r.historyItems.get('tool').detailsTruncated, true);
});
