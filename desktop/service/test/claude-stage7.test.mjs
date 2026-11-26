import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { inspectItem } from '../chat-inspector.mjs';
import { claudeChanges, reviewDraft } from '../claude-changes.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-stage7-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd, effort: 'low' };
  const wire = claudeFixture(session.nativeId), runtime = new ClaudeChat({ session, stateDir: cwd, transportFactory: wire.factory });
  await runtime.start(); t.after(async () => { await runtime.close(); wire.close(); });
  return { runtime, session, wire, emit: frame => [...wire.transports][0].emit(frame) };
}
const agent = (sessionId, id = 'toolu_child') => ({ type: 'assistant', session_id: sessionId, message: { id: 'parent-agent', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Fixture explorer', subagent_type: 'general-purpose', prompt: 'Inspect synthetic data' } }] } });

test('unowned child frames are ignored and historical snapshots never authorize live child routing', async t => {
  const { runtime, session, emit } = await fixture(t); runtime.submit('slow');
  emit({ type: 'assistant', session_id: session.nativeId, parent_tool_use_id: 'foreign', message: { id: 'foreign', content: [{ type: 'text', text: 'FOREIGN' }] } });
  assert.equal(runtime.subagents.snapshot().length, 0);
  emit(agent(session.nativeId));
  emit({ type: 'control_request', request_id: 'child-approval', parent_tool_use_id: 'toolu_child', session_id: 'child-native', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'fixture.txt' } } });
  assert.equal(runtime.snapshot().requests[0].agentLabel, 'Fixture explorer');
  assert.equal(runtime.snapshot().sessionId, session.nativeId);
  const saved = runtime.subagents.save();
  runtime.subagents.records.clear(); runtime.subagents.tools.clear(); runtime.subagents.restore(saved);
  emit({ type: 'assistant', session_id: session.nativeId, parent_tool_use_id: 'toolu_child', message: { id: 'late', content: [{ type: 'text', text: 'AFTER_RESTART' }] } });
  assert.equal(runtime.subagents.snapshot()[0].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(runtime.subagents.read('toolu_child')), /AFTER_RESTART/);
});

test('confirmed native Edit changes use exact hunks and shared inspector, while failures record no diff', async t => {
  const { runtime, session, emit } = await fixture(t); runtime.submit('slow');
  const file = path.join(session.cwd, 'fixture.txt');
  emit({ type: 'assistant', session_id: session.nativeId, message: { id: 'edit', content: [{ type: 'tool_use', id: 'edit-tool', name: 'Edit', input: { file_path: file, old_string: 'old', new_string: 'new' } }] } });
  emit({ type: 'user', session_id: session.nativeId, message: { content: [{ type: 'tool_result', tool_use_id: 'edit-tool', content: 'Updated fixture' }] }, tool_use_result: { filePath: file, structuredPatch: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-old', '+new'] }] } });
  assert.equal(runtime.snapshot().items.find(item => item.id === 'edit:0').type, 'fileChange');
  const result = inspectItem(runtime, 'edit:0'); assert.equal(result.files[0].patches[0].rows.find(row => row.type === 'add').next, 7);
  assert.equal(claudeChanges({ tool: 'Edit', input: { file_path: file } }, { is_error: true }, {}, session.cwd), undefined);
});

test('a launched asynchronous child blocks protected refresh until its native completion, without reopening on late start', async t => {
  const { runtime, session, emit, wire } = await fixture(t); runtime.submit('slow'); emit(agent(session.nativeId));
  emit({ type: 'system', session_id: session.nativeId, subtype: 'task_started', task_id: 'async-child', tool_use_id: 'toolu_child', run_id: '001' });
  emit({ type: 'user', session_id: session.nativeId, tool_use_result: { isAsync: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'Internal launch metadata' }] } });
  emit({ type: 'result', session_id: session.nativeId, subtype: 'success', is_error: false });
  assert.equal(runtime.snapshot().status, 'ready'); assert.equal(runtime.subagents.hasActive, true); assert.equal(runtime.ready(), false);
  assert.throws(() => runtime.prepareReview({ type: 'uncommittedChanges' }), /Finish work/);
  emit({ type: 'system', session_id: session.nativeId, subtype: 'task_notification', task_id: 'async-child', run_id: '001', status: 'completed', summary: 'Finished' });
  emit({ type: 'system', session_id: session.nativeId, subtype: 'task_started', task_id: 'async-child', run_id: '001' });
  assert.equal(runtime.subagents.hasActive, false); assert.equal(runtime.ready(), true);
  const before = wire.calls.length;
  assert.equal(runtime.prepareReview({ type: 'baseBranch', branch: 'main' }).sent, false);
  assert.match(runtime.draft, /Do not modify files/); assert.equal(wire.calls.length, before);
  assert.throws(() => runtime.prepareReview({ type: 'uncommittedChanges' }), /clear the composer/);
  assert.throws(() => reviewDraft({ type: 'commit', sha: '-bad\nrequest' }), /valid/);
});
