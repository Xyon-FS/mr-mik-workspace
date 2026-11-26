import test from 'node:test';
import assert from 'node:assert/strict';
import { messageActionRequest, completeMessageAction } from '../../../src/desktop/messageActionRequest.ts';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('pending message action identity survives new views and keeps sessions/items/actions separate', () => {
  const cache = storage(), id = messageActionRequest('source', 'answer', 'retry', cache);
  assert.equal(messageActionRequest('source', 'answer', 'retry', cache), id);
  assert.notEqual(messageActionRequest('source', 'answer', 'branch', cache), id);
  assert.notEqual(messageActionRequest('other', 'answer', 'retry', cache), id);
  assert.notEqual(messageActionRequest('source', 'different', 'retry', cache), id);
  completeMessageAction('source', 'answer', 'retry', 'old-response', cache);
  assert.equal(messageActionRequest('source', 'answer', 'retry', cache), id);
  completeMessageAction('source', 'answer', 'retry', id, cache);
  assert.notEqual(messageActionRequest('source', 'answer', 'retry', cache), id);

  cache.setItem = () => { throw new Error('Synthetic browser cache full'); };
  assert.throws(() => messageActionRequest('new-source', 'answer', 'retry', cache), /cache full/);
});
