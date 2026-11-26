import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeModelPicker } from '../claude-model-picker.mjs';
import { claudeModelScreen } from './claude-picker-layouts.mjs';

test('Claude first picker waits for the initial prompt instead of rejecting startup frames', async () => {
  let reads = 0, screen = 'Starting Claude', input = [];
  const session = { agent: 'claude', status: 'running', activity: 'idle', process: {} };
  const sessions = { get: () => session, read: async () => { if (++reads === 3) screen = '│ ❯ │\n' + '\n'.repeat(22) + 'footer'; return { screen }; }, input: (_id, key) => { input.push(key); screen = key === '/model' ? '❯ /model' : claudeModelScreen(); } };
  const picker = new ClaudeModelPicker(sessions);
  assert.equal((await picker.open('fresh')).options.length, 5);
  assert.deepEqual(input, ['/model', '\r']);
});
