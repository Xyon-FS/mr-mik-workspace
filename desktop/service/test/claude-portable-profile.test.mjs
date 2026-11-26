import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isolatedClaudeEnvironment } from '../../../scripts/claude-portable-profile.mjs';

test('portable Claude test profile drops inherited inference credentials and isolates native and webview state', () => {
  const base = { PATH: 'synthetic-path', HOME: 'keep-home', USERPROFILE: 'keep-user', ANTHROPIC_API_KEY: 'synthetic-secret', ANTHROPIC_BASE_URL: 'https://invalid.example', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-token', CLAUDECODE: 'parent', MRMAK_BRIDGE_TOKEN: 'synthetic-bridge', WEBVIEW2_USER_DATA_FOLDER: 'original-browser' };
  const env = isolatedClaudeEnvironment('test-profile', base);
  assert.equal(env.HOME, base.HOME); assert.equal(env.USERPROFILE, base.USERPROFILE);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join('test-profile', 'Claude'));
  assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, path.join('test-profile', 'WebView2'));
  assert.equal(env.CODEX_HOME, path.join('test-profile', 'Codex'));
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'MRMAK_BRIDGE_TOKEN']) assert.equal(env[name], undefined);
  assert.equal(base.ANTHROPIC_API_KEY, 'synthetic-secret', 'Parent environment must remain unchanged');
});
