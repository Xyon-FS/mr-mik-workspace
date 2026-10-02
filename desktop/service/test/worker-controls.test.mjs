import test from 'node:test';
import assert from 'node:assert/strict';
import { workerControls } from '../worker-controls.mjs';
import { MakActions } from '../mak-actions.mjs';
import { coordinatorTools } from '../coordinator.mjs';

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

test('Mik exposes OpenCode, preserves card scope and confirmations, and rejects foreign targets and Codex-style effort', async () => {
  const f = fixture(), calls = [];
  const coordinator = { cancelled: new Set(), operations: new Map([['op', { text: 'Create work' }]]), active: { observedChats: new Map() }, requireConfirmation: async () => calls.push('confirm') };
  const actions = new MakActions({
    repo: 'hub', projects: { get: async () => ({ id: 'workspace', repositories: [{ id: 'unity', available: true }] }) },
    registry: async () => ({ entities: [{ id: 'card', projectId: 'workspace', repositoryId: 'unity' }] }),
    sessions: { ...f.sessions, read: async () => ({ screen: 'Native input' }) }, coordinator: () => coordinator,
    createChat: async options => { calls.push(options); return { ...options, id: 'owned' }; }, focus: () => {},
    workerControls: { send: async () => calls.push('send'), interrupt: async () => calls.push('abort'), prepare: async () => {} },
  });
  const scope = { projectId: 'workspace', cardId: 'card' };
  assert.ok(coordinatorTools.find(item => item.name === 'open_chat').inputSchema.properties.agent.enum.includes('opencode'));
  await actions.execute('open_chat', { agent: 'opencode', name: 'Unity work' }, 'op', scope);
  assert.equal(calls[0], 'confirm'); assert.equal(calls[1].repositoryId, 'unity'); assert.equal(calls[1].cardId, 'card'); assert.equal(calls[1].effort, undefined);
  await assert.rejects(actions.execute('open_chat', { agent: 'opencode', name: 'Work', effort: 'high' }, 'op', scope), /variants/);
  await assert.rejects(actions.execute('open_chat', { agent: 'opencode', name: 'Work', projectId: 'foreign' }, 'op', scope), /workspace/);
  await assert.rejects(actions.execute('send_to_chat', { id: 'owned', text: 'Task' }, 'op', scope), /Read/);
  await actions.execute('read_chat', { id: 'owned' }, 'op', scope);
  await actions.execute('send_to_chat', { id: 'owned', text: 'Task' }, 'op', scope);
  assert.deepEqual(calls.slice(-2), ['confirm', 'send']);
  f.chat.lastInputAt = 'changed'; await assert.rejects(actions.execute('send_to_chat', { id: 'owned', text: 'Task' }, 'op', scope), /Read/);
  await actions.execute('read_chat', { id: 'owned' }, 'op', scope);
  coordinator.requireConfirmation = async () => { throw new Error('Declined'); };
  await assert.rejects(actions.execute('send_to_chat', { id: 'owned', text: 'Task' }, 'op', scope), /Declined/);
  coordinator.requireConfirmation = async () => { calls.push('confirm'); f.chat.lastInputAt = 'intervening typing'; };
  await assert.rejects(actions.execute('send_to_chat', { id: 'owned', text: 'Task' }, 'op', scope), /Read/);
  coordinator.requireConfirmation = async () => calls.push('confirm');
  await actions.execute('interrupt_chat', { id: 'owned' }, 'op', scope); assert.deepEqual(calls.slice(-2), ['confirm', 'abort']);
  f.chat.projectId = 'foreign'; await assert.rejects(actions.execute('interrupt_chat', { id: 'owned' }, 'op', scope), /outside/);
});
