import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-turn-timing-'));
  const transport = graphicalFixture();
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask' }, env: { ...process.env, CODEX_HOME: root }, spawnChild: transport.spawnChild });
  t.after(async () => { await runtime.close(); for (const child of transport.children) child.kill(); }); await runtime.start();
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, ...params } });
  return { root, runtime, transport, notify };
}

test('timeline streams public reasoning, keeps native timing and rejects stale completion', async t => {
  const { root, runtime, notify } = await fixture(t);
  notify('turn/started', { turn: { id: 'turn', status: 'inProgress', startedAt: 100 } });
  notify('item/reasoning/summaryTextDelta', { itemId: 'summary', turnId: 'turn', summaryIndex: 0, delta: 'Public first' });
  notify('item/reasoning/summaryPartAdded', { itemId: 'summary', summaryIndex: 1 });
  notify('item/reasoning/summaryTextDelta', { itemId: 'summary', summaryIndex: 1, delta: 'Public second' });
  notify('item/reasoning/textDelta', { itemId: 'summary', delta: 'RAW_SECRET_REASONING' });
  assert.equal(runtime.items.get('summary').type, 'reasoning');
  assert.equal(runtime.items.get('summary').text, 'Public first\n\nPublic second');
  notify('item/completed', { turnId: 'turn', item: { id: 'summary', type: 'reasoning', summary: ['Final public'], content: ['RAW_SECRET_REASONING'] } });
  assert.equal(runtime.items.get('summary').text, 'Final public');
  assert.equal(runtime.items.get('summary').turnId, 'turn');
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /RAW_SECRET/);
  const live = runtime.snapshot().turns.find(turn => turn.id === 'turn');
  assert.equal(live.startedAt, 100000);
  assert.equal(live.timingSource, 'native');
  notify('item/completed', { turnId: 'turn', item: { id: 'tool', type: 'commandExecution', command: 'synthetic', cwd: root, status: 'completed', exitCode: 7, durationMs: 1234 } });
  assert.equal(runtime.items.get('tool').exitCode, 7); assert.equal(runtime.items.get('tool').durationMs, 1234);
  runtime.upsert({ id: 'mcp', type: 'mcpToolCall', server: 'fixture', tool: 'search', durationMs: 400 });
  assert.equal(runtime.items.get('mcp').server, 'fixture');
  notify('turn/completed', { turn: { id: 'older', status: 'completed', startedAt: 10, completedAt: 11 } });
  assert.equal(runtime.turnId, 'turn');
  notify('turn/completed', { turn: { id: 'turn', status: 'failed', startedAt: 100, completedAt: 102, durationMs: 2100 } });
  assert.equal(runtime.snapshot().turns.find(turn => turn.id === 'turn').durationMs, 2100);
  assert.equal(runtime.snapshot().working, false);
  notify('turn/started', { turn: { id: 'next', status: 'inProgress', startedAt: 103 } });
  runtime.disconnected();
  const pending = runtime.snapshot().turns.find(turn => turn.id === 'next');
  assert.equal(pending.status, 'inProgress');
  assert.equal(pending.completedAt, null);
  assert.ok(pending.observedUntil >= pending.startedAt);
});
