import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalEnvironment } from '../agents.mjs';

test('embedded Claude terminal requests fullscreen and ConPTY repaint without changing account or Bridge environment', () => {
  const env = { TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: 'synthetic-profile', MRMAK_BRIDGE_URL: 'http://127.0.0.1:1', MRMAK_BRIDGE_TOKEN: 'synthetic', CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' };
  const before = { ...env }, result = terminalEnvironment('claude', env);
  assert.deepEqual(env, before);
  assert.deepEqual(result, process.platform === 'win32' ? { ...before, CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1' } : before);
  assert.equal(terminalEnvironment('claude', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' }).CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, '1');
  for (const agent of ['codex', 'opencode', 'shell']) assert.equal(terminalEnvironment(agent, env), env);
});
