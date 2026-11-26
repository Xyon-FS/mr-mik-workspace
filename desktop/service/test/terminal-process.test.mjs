import test from 'node:test';
import assert from 'node:assert/strict';
import { protectTerminalKill } from '../terminal-process.mjs';

test('terminal ownership is per process and a synchronous failed request stays visible and retryable', () => {
  let calls = 0;
  const proc = protectTerminalKill({ kill() { if (++calls === 1) throw new Error('Synthetic native kill failure'); this.kill(); } });
  assert.throws(() => proc.kill(), /native kill failure/);
  proc.kill(); proc.kill(); assert.equal(calls, 2);
  let sibling = 0; protectTerminalKill({ kill() { sibling++; } }).kill();
  assert.equal(sibling, 1);
});
