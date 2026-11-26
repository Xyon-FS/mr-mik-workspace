import test from 'node:test';
import assert from 'node:assert/strict';
import { cliModelLabel } from '../cli-model-label.mjs';

test('CLI headers and selection notices report the effective native model', () => {
  assert.equal(cliModelLabel('│ model: gpt-6.1-sol high /model to change │', 'codex'), 'gpt-6.1-sol');
  assert.equal(cliModelLabel('model: gpt-6-luna\n› Ask Codex', 'codex'), 'gpt-6-luna');
  assert.equal(cliModelLabel('  Sonnet 4.5 · Claude Pro\n❯', 'claude'), 'Sonnet 4.5');
  assert.equal(cliModelLabel('Opus · Claude Max', 'claude'), 'Opus');
  assert.equal(cliModelLabel('▝▜█████▛▘  Sonnet 4.5 · Claude Pro', 'claude'), 'Sonnet 4.5');
  assert.equal(cliModelLabel('▝▜██████▀  Haiku 5.5 · API Usage Billing', 'claude'), 'Haiku 5.5');
  assert.equal(cliModelLabel('▝▜██████▀  Fable 5.1 · Claude Max', 'claude'), 'Fable 5.1');
  assert.equal(cliModelLabel('Opus 5.5 (1M context) · Claude Max', 'claude'), 'Opus 5.5 (1M context)');
  assert.equal(cliModelLabel('Claude Code v2.1.316\n▝▜██████▀  Future 7.1 · Claude Max', 'claude'), 'Future 7.1');
  assert.equal(cliModelLabel('model: gpt-6.1-sol\n• Model changed to gpt-6-luna low', 'codex'), 'gpt-6-luna');
  assert.equal(cliModelLabel('Sonnet 4.5 · Claude Pro\nSet model to Haiku for this session only', 'claude'), 'Haiku');
  assert.equal(cliModelLabel('Set model to Sonnet\nSet model to Opus', 'claude'), 'Opus');
  assert.equal(cliModelLabel('Model changed to gpt-6-luna low\nOpenAI Codex (v1)\nmodel: gpt-6.1-terra high', 'codex'), 'gpt-6.1-terra');
  assert.equal(cliModelLabel('Set model to Haiku\nClaude Code v2.1.316\n▝▜██████▀  Fable 5.1 · Claude Max', 'claude'), 'Fable 5.1');
  assert.equal(cliModelLabel('Model changed to gpt-6-luna low\nOpenAI Codex (v1)\n? Ask Codex to do anything', 'codex'), null);
});

test('ordinary prose and unknown layouts do not invent a model', () => {
  for (const agent of ['codex', 'claude', 'opencode']) {
    assert.equal(cliModelLabel('Please use Sonnet\nThe model is gpt-6-luna\n› /model', agent), null);
    assert.equal(cliModelLabel('', agent), null);
  }
});
