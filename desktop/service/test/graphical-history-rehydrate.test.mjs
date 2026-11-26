import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Claude can rehydrate visited history while retaining a bounded cache and leaving undisclosed IDs alone', async () => {
  const items = Array.from({ length: 620 }, (_, i) => ({ id: `item-${i}`, type: 'agentMessage', text: `Saved ${i}`, status: 'completed' }));
  let reads = 0;
  const runtime = Object.create(ClaudeChat.prototype);
  Object.assign(runtime, { loadedHistory: new Map(), historyMetadata: new Map(), protocol: { state: { items: [] } }, resultAssets: new Map(), runtimeId: 'runtime', history: { page: async ({ aroundId }) => { reads++; return { items: items.filter(item => item.id === aroundId), turns: [], nextCursor: null, hasOlder: true }; } } });
  runtime.historyPage({ items, turns: [], nextCursor: null, hasOlder: false });
  assert.equal(runtime.loadedHistory.size, 500); assert.equal(runtime.loadedHistory.has('item-0'), false);
  await runtime.ensureHistoryItem('unknown'); assert.equal(reads, 0);
  await runtime.ensureHistoryItem('item-0'); assert.equal(reads, 1); assert.equal((runtime.items.get('item-0') || runtime.historyItems.get('item-0')).text, 'Saved 0');
  assert.equal(runtime.loadedHistory.size, 500);
  await runtime.ensureHistoryItem('item-0'); assert.equal(reads, 1);
});

test('evicted history remains available through authenticated output and quote routes without sending a prompt', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-history-rehydrate-'));
  let service;
  try {
    const repo = path.join(base, 'hub'), home = path.join(base, 'home');
    await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
    service = await createService({ repo, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } });
    service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
    const profile = await service.profiles.create('History fixture'), transport = graphicalFixture();
    service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
    const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', cwd: repo, accountProfileId: profile.id });
    const runtime = service.sessions.get(session.id).graphical;
    const records = [{ id: 'old-output', type: 'commandExecution', command: 'synthetic', aggregatedOutput: 'Retained native output.', status: 'completed', exitCode: 0 }, ...Array.from({ length: 600 }, (_, i) => ({ id: `saved-${i}`, type: 'agentMessage', text: `Saved ${i}`, status: 'completed' }))];
    transport.history.set(runtime.threadId, records);
    runtime.historyPage(records, { turns: [], nextCursor: null, hasOlder: false });
    assert.equal(runtime.historyItems.has('old-output'), false);
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const output = await fetch(`${service.origin}/api/sessions/${session.id}/chatoutput?item=old-output`, { headers });
    assert.equal(output.ok, true); assert.equal((await output.json()).text, 'Retained native output.');
    runtime.historyPage(records.slice(100), { turns: [], nextCursor: null, hasOlder: true });
    assert.equal(runtime.historyItems.has('saved-0'), false);
    const quote = await fetch(`${service.origin}/api/sessions/${session.id}/chat`, { method: 'POST', headers, body: JSON.stringify({ action: 'composer-add', context: { type: 'quote', itemId: 'saved-0', text: 'Saved 0' } }) });
    assert.equal(quote.ok, true, await quote.text()); assert.equal(runtime.composer.items[0].text, 'Saved 0');
    const missing = await fetch(`${service.origin}/api/sessions/${session.id}/chatoutput?item=never-disclosed`, { headers }); assert.equal(missing.ok, false);
    const live = { id: 'visited-live', type: 'agentMessage', text: 'Visited live source', status: 'completed', details: '' };
    records.push(live); runtime.items.set(live.id, live); runtime.snapshot(); runtime.items.delete(live.id);
    const restoredLive = await fetch(`${service.origin}/api/sessions/${session.id}/chat`, { method: 'POST', headers, body: JSON.stringify({ action: 'composer-add', context: { type: 'quote', itemId: live.id, text: live.text } }) });
    assert.equal(restoredLive.ok, true, await restoredLive.text());
    assert.ok(runtime.historyItems.size <= 250); assert.ok(runtime.outputs.size <= 400);
    assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
  } finally { await service?.close(); await cleanupFixtures(); }
});
