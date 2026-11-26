import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCliPermissions, claudeCliPermissionMode } from '../claude-cli-permissions.mjs';

test('Claude CLI reads modes only from the native footer', () => {
  assert.equal(claudeCliPermissionMode('❯\n ⏵⏵ auto mode on (shift+tab to cycle)'), 'auto');
  assert.equal(claudeCliPermissionMode('❯\n ⏸ manual mode on · ? for shortcuts'), 'default');
  assert.equal(claudeCliPermissionMode('❯\n ⏵⏵ accept edits on (shift+tab to cycle)'), 'acceptEdits');
  assert.equal(claudeCliPermissionMode('The requested auto mode is enabled'), null);
});

function fixture() {
  const cycle = ['auto', 'default', 'acceptEdits', 'plan']; let index = 0;
  const titles = ['auto mode', 'manual mode', 'accept edits', 'plan mode'];
  const session = { agent: 'claude', chatInterface: 'cli', status: 'running', activity: 'idle', process: {} }, keys = [];
  const sessions = { get: () => session, read: async () => ({ screen: `❯\n ⏵⏵ ${titles[index]} on (shift+tab to cycle)` }), input: (_id, key) => { keys.push(key); index = (index + 1) % cycle.length; }, changed() {}, async persist() {} };
  return { session, keys, picker: new ClaudeCliPermissions(sessions) };
}

test('Claude permissions change in the same process after native confirmation', async () => {
  const { session, keys, picker } = fixture(), process = session.process;
  await picker.chooseMode('test', 'acceptEdits');
  assert.deepEqual(keys, ['\x1b[Z', '\x1b[Z']);
  assert.equal(session.claudePermissionMode, 'acceptEdits'); assert.equal(session.process, process);
  assert.equal(session.nativeControlBusy, false);
  await assert.rejects(picker.chooseMode('test', 'bypassPermissions'), /original mode was restored/);
  assert.equal(keys.length, 6); assert.equal(session.nativeControlBusy, false);
  session.activity = 'working';
  await assert.rejects(picker.chooseMode('test', 'auto'), /idle/); assert.equal(keys.length, 6);
  assert.equal(session.claudePermissionMode, 'acceptEdits');
});
