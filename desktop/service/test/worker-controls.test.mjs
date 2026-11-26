import test from 'node:test';
import assert from 'node:assert/strict';
import { workerControls } from '../worker-controls.mjs';

function fixture() {
  const chat = { id: 'owned', agent: 'opencode', name: 'Fixture work', projectId: 'workspace', activity: 'idle', attention: false, process: {}, lastInputAt: null };
  const events = [];
  const sessions = { get: () => chat, input: (...args) => { events.push(['paste', ...args]); return { delivered: true }; }, changed: () => events.push(['changed']) };
  const picker = { command: async (_id, action) => events.push(['native', action]) };
  return { chat, events, sessions, picker, controls: workerControls(sessions, picker) };
}

test('OpenCode worker delivery probes readiness, pastes once, natively submits and aborts without generic keys', async () => {
  const f = fixture();
  assert.equal((await f.controls.send('owned', 'Task')).delivered, true);
  assert.deepEqual(f.events.slice(0, 3), [['native', 'prepare'], ['paste', 'owned', 'Task', { coordinator: true, submit: false }], ['native', 'submit']]);
  assert.equal(f.chat.hasConversation, true);
  await f.controls.interrupt('owned'); assert.deepEqual(f.events.at(-1), ['native', 'interrupt']);
  f.chat.agent = 'claude'; await f.controls.send('owned', 'Claude task');
  assert.deepEqual(f.events.at(-1), ['paste', 'owned', 'Claude task', { coordinator: true, submit: true }]);
});

test('OpenCode controls fail closed before paste and do not retry a draft after failed submission', async () => {
  const f = fixture();
  f.chat.attention = true; await assert.rejects(f.controls.send('owned', 'Task'), /native prompts/); assert.equal(f.events.length, 0);
  f.chat.attention = false;
  f.picker.command = async () => { throw new Error('Native dialog'); };
  await assert.rejects(f.controls.send('owned', 'Task'), /Native dialog/); assert.equal(f.events.length, 0);
  f.picker.command = async (_id, action) => { if (action === 'submit') throw new Error('Unavailable'); };
  await assert.rejects(f.controls.send('owned', 'Task'), /pasted.*not confirmed/);
  assert.equal(f.events.filter(item => item[0] === 'paste').length, 1); assert.equal(f.chat.hasConversation, undefined);
  f.events.length = 0;
  f.picker.command = async () => { f.chat.process = {}; };
  await assert.rejects(f.controls.send('owned', 'Task'), /changed/); assert.equal(f.events.length, 0);
});
