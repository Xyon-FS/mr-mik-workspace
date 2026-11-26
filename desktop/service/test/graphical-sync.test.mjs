import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicalSync } from '../graphical-sync.mjs';

test('chat deltas preserve order, report removals and changed rows, and recover a missing base', () => {
  let calls = 0;
  const runtime = { runtimeId: 'fixture', revision: 1, items: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Partial' }], snapshot() { calls++; return { runtimeId: this.runtimeId, revision: this.revision, items: this.items, turns: [{ id: 'turn', status: 'running' }], working: true }; } };
  assert.equal(graphicalSync(runtime, -1, '').mode, 'full');
  assert.equal(graphicalSync(runtime, 1, 'fixture').mode, 'unchanged'); assert.equal(calls, 1);
  runtime.items[1].text += ' answer'; runtime.revision++;
  const delta = graphicalSync(runtime, 1, 'fixture');
  assert.equal(delta.mode, 'patch'); assert.deepEqual(delta.items.upsert, [{ id: 'b', text: 'Partial answer' }]); assert.deepEqual(delta.items.order, ['a', 'b']); assert.deepEqual(delta.turns.upsert, []);
  runtime.items.shift(); runtime.items.push({ id: 'c', text: 'Next' }); runtime.revision++;
  const removed = graphicalSync(runtime, 2, 'fixture'); assert.deepEqual(removed.items.removed, ['a']); assert.deepEqual(removed.items.order, ['b', 'c']);
  assert.equal(graphicalSync(runtime, 1, 'fixture').mode, 'full');
  runtime.runtimeId = 'reconnected'; runtime.revision = 1;
  assert.equal(graphicalSync(runtime, 3, 'fixture').mode, 'full');
});
