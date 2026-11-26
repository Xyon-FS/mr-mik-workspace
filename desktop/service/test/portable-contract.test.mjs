import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransferredSessions } from '../portable-contract.mjs';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const parent = { id: parentId, agent: 'codex', nativeId: 'parent-thread' };
const child = { id: childId, agent: 'codex', nativeId: 'child-thread', messageOrigin: { sessionId: parentId, threadId: 'parent-thread', itemId: 'item-1', kind: 'branch' } };

test('duplicate sessions, malformed origins, mismatched parents and cycles fail before import', () => {
  assert.throws(() => validateTransferredSessions([parent, parent]), /duplicate/);
  assert.throws(() => validateTransferredSessions([{ ...child, chatInterface: 'unexpected' }]), /metadata/);
  assert.throws(() => validateTransferredSessions([{ ...child, messageOrigin: { ...child.messageOrigin, kind: 'execute' } }]), /origin metadata/);
  assert.throws(() => validateTransferredSessions([{ ...parent, nativeId: 'other' }, child]), /does not match/);
  const cyclic = { ...parent, messageOrigin: { sessionId: childId, threadId: child.nativeId, itemId: 'item-2', kind: 'retry' } };
  assert.throws(() => validateTransferredSessions([cyclic, child]), /circular/);
});
