import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudePendingAction, writeClaudePendingAction } from '../../../src/desktop/claudePendingAction.ts';

function cache() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const pending = id => ({ id, action: 'steer', signature: '["guidance",4]', revision: 4, expectedTurnId: 'synthetic-turn' });

test('guidance/enqueue identity and draft generation survive a new view without crossing sessions', () => {
  const storage = cache();
  writeClaudePendingAction('first', pending('A'), undefined, storage);
  assert.deepEqual(readClaudePendingAction('first', storage), pending('A'));
  assert.equal(readClaudePendingAction('second', storage), null);
  writeClaudePendingAction('second', { ...pending('B'), action: 'enqueue', expectedTurnId: null }, undefined, storage);
  writeClaudePendingAction('first', null, 'A', storage);
  assert.equal(readClaudePendingAction('first', storage), null);
  assert.equal(readClaudePendingAction('second', storage).action, 'enqueue');
});

test('an older view response cannot erase a newer pending action and write failures propagate', () => {
  const storage = cache();
  writeClaudePendingAction('first', pending('A'), undefined, storage);
  writeClaudePendingAction('first', pending('B'), undefined, storage);
  writeClaudePendingAction('first', null, 'A', storage);
  assert.equal(readClaudePendingAction('first', storage).id, 'B');
  const failed = { ...storage, setItem: () => { throw new Error('Synthetic cache full'); } };
  assert.throws(() => writeClaudePendingAction('first', pending('C'), undefined, failed), /cache full/);
  assert.equal(readClaudePendingAction('first', storage).id, 'B');
});
