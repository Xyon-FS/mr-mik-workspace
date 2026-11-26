import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeAccountLimits, readCodexAccountLimits } from '../account-limit-probes.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

test('Codex Settings probe reads native limits without creating, resuming or sending to a thread', async () => {
  const calls = []; let closed = false;
  const value = await readCodexAccountLimits({ cwd: 'fixture', env: { selected: 'profile' } }, { createProbe: (cwd, env) => { assert.equal(cwd, 'fixture'); assert.equal(env.selected, 'profile'); return { initialize: async () => calls.push('initialize'), rpc: async (method, params) => { calls.push([method, params]); return { rateLimitsByLimitId: { native: { limitName: 'Native', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000000000 } } }, token: 'PRIVATE' }; }, close: async () => { closed = true; } }; } });
  assert.deepEqual(calls, ['initialize', ['account/rateLimits/read', {}]]); assert.equal(value.windows[0].percent, 0); assert.equal(closed, true); assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test('Claude Settings probe initializes and requests structured usage only, with no transcript scan or inference', async () => {
  let fixture, transportClosed = false;
  const value = await readClaudeAccountLimits({ cwd: 'fixture', env: { CLAUDE_CONFIG_DIR: 'selected-profile' } }, { binary: { file: 'synthetic', args: [] }, transportFactory: options => {
    assert.equal(options.env.CLAUDE_CONFIG_DIR, 'selected-profile'); assert.ok(options.binary.args.includes('--no-session-persistence')); assert.ok(options.binary.args.includes('--strict-mcp-config')); assert.ok(options.binary.args.includes('--setting-sources'));
    fixture = claudeFixture(null, { usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 31, resets_at: null }, model_scoped: [{ display_name: 'Native model', utilization: 12, resets_at: null }] }, token: 'PRIVATE' } });
    const factory = hooks => { const wire = fixture.factory({ ...hooks, resumeSessionId: null }); return wire; };
    return { factory, close: async () => { fixture.close(); transportClosed = true; } };
  } });
  const controls = fixture.calls.map(call => call.request);
  assert.deepEqual(controls, [{ subtype: 'initialize' }, { subtype: 'get_usage', skip_behaviors: true }]); assert.equal(transportClosed, true); assert.equal(value.windows[0].percent, 31); assert.equal(value.windows[1].percent, 12); assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});
