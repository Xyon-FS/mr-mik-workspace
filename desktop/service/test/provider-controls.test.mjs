import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { NativeControls } from '../native-controls.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-native-controls-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd: root };
  const fixture = claudeFixture(session.nativeId, { commands: [{ name: 'compact', builtin: true }], ...options });
  const runtime = new ClaudeChat({ session, stateDir: root, transportFactory: fixture.factory }); await runtime.start();
  t.after(async () => { await runtime.close(); fixture.close(); }); return { runtime, fixture, root, session };
}

test('Claude usage uses summary and skip-behaviors controls while preserving pending context', async t => {
  const { runtime, fixture } = await setup(t, { contextUsage: { totalTokens: 12, maxTokens: 100 }, usage: { session: { model_usage: { m: { inputTokens: 0, outputTokens: 0 } } }, rate_limits_available: false } });
  runtime.draft = 'Unsent'; await runtime.composer.add({ type: 'quote', itemId: 'missing' }).catch(() => {});
  await runtime.refreshUsage(); assert.equal(runtime.draft, 'Unsent'); assert.equal(runtime.snapshot().usage.tokens.input, 0);
  assert.deepEqual(fixture.calls.filter(m => m.request?.subtype.startsWith('get_') && m.request.subtype !== 'get_settings').map(m => m.request), [{ subtype: 'get_context_usage', detail: 'summary' }, { subtype: 'get_usage', skip_behaviors: true }]);
  assert.equal(fixture.calls.filter(m => m.type === 'user').length, 0);
  runtime.draft = ''; runtime.submit('slow'); await assert.rejects(runtime.refreshUsage(), /idle/);
});

test('Claude compaction requires native capability and clear pending input, keeps identity, and deduplicates dispatch', async t => {
  const { runtime, fixture, session } = await setup(t);
  runtime.draft = 'Preserve'; await assert.rejects(runtime.compact(randomUUID()), /clear pending input/); assert.equal(runtime.draft, 'Preserve'); runtime.draft = '';
  const id = randomUUID(); await runtime.compact(id); assert.equal(runtime.snapshot().compaction.status, 'completed');
  assert.equal(runtime.protocol.state.sessionId, session.nativeId); assert.equal(runtime.snapshot().items.length, 0);
  await runtime.compact(id); assert.equal(fixture.calls.filter(m => m.type === 'user').length, 1);
  await runtime.compact(randomUUID()); await assert.rejects(runtime.compact(id), /already handled/);
  runtime.protocol.initialization.commands = []; await assert.rejects(runtime.compact(randomUUID()), /unavailable/);
});

test('Claude compaction without a native boundary is uncertain and is never repeated by status reads', async t => {
  const { runtime, fixture } = await setup(t, { missingCompactBoundary: true });
  const id = randomUUID(); await runtime.compact(id); assert.equal(runtime.snapshot().compaction.status, 'uncertain');
  for (let n = 0; n < 3; n++) { runtime.snapshot(); await runtime.compact(id); }
  assert.equal(fixture.calls.filter(m => m.type === 'user').length, 1);
  await assert.rejects(runtime.compact(randomUUID()), /uncertain/);
  runtime.dismissCompaction(); assert.equal(runtime.snapshot().compaction, null);
});

test('timed-out compaction and persisted reservation cannot silently dispatch again after reconnect', async t => {
  const { runtime, fixture, session, root } = await setup(t, { holdCompact: true }); runtime.compactionTimeoutMs = 15;
  const id = randomUUID(); await runtime.compact(id);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(runtime.snapshot().compaction.status, 'uncertain');
  await runtime.persistState(); await runtime.close();
  const replacement = new ClaudeChat({ session, stateDir: root, transportFactory: fixture.factory }); t.after(() => replacement.close()); await replacement.start();
  await replacement.compact(id); await assert.rejects(replacement.compact(randomUUID()), /uncertain/);
  assert.equal(fixture.calls.filter(m => m.type === 'user').length, 1);
});

test('OpenCode reserves compaction before native dispatch; lost replies and new launches never replay it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-native-controls-'));
  const source = { id: randomUUID(), nativeId: 'ses_fixture', agent: 'opencode', openCodeFamily: 2, chatInterface: 'cli', status: 'running', process: {}, activity: 'idle', openCodeLaunchId: 'launch', hasConversation: true };
  const calls = [], history = { store: () => ({}), read: async () => ({ info: { id: source.nativeId }, messages: [{ id: 'msg_old', type: 'user' }] }) };
  const picker = { command: async (id, action) => { calls.push(action); if (action === 'compact') throw new Error('Lost reply'); if (action === 'controls') return { commands: [{ id: 'session.compact', enabled: true }] }; return { models: [] }; } };
  const controls = new NativeControls({ stateDir: root }, picker, history), request = { action: 'compact', launchId: 'launch', requestId: randomUUID() };
  await assert.rejects(controls.act(source, request), /Lost reply/);
  await controls.act(source, request); assert.equal(calls.filter(action => action === 'compact').length, 1);
  assert.equal((await controls.act(source, { action: 'inspect', launchId: 'launch' })).operation.status, 'uncertain');
  source.openCodeLaunchId = 'replacement';
  await assert.rejects(controls.act(source, { ...request, requestId: randomUUID(), launchId: 'replacement' }), /previous compaction/);
  await assert.rejects(controls.act(source, request), /changed/);
  assert.equal(source.nativeControlBusy, false);
});
