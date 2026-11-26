import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { providerMessageReceipt } from '../provider-message-receipts.mjs';
import { mkdtemp } from './fixtures.mjs';

test('read-only preflight failure may retry its same ID, while a reserved uncertain action never replays', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-message-receipts-'));
  const sessions = { stateDir: root }, source = { id: randomUUID(), nativeId: randomUUID() };
  const request = { requestId: randomUUID(), kind: 'retry', itemId: 'synthetic-response' };
  let repaired = false, effects = 0;
  const run = () => providerMessageReceipt({ sessions, source, request, prepare: async () => { if (!repaired) throw new Error('Synthetic missing context'); }, execute: async () => { effects++; throw new Error('Synthetic uncertain native response'); } });
  await assert.rejects(run(), /missing context/);
  assert.deepEqual(await readdir(root), []); assert.equal(effects, 0);
  repaired = true;
  await assert.rejects(run(), /uncertain native response/); assert.equal(effects, 1);
  source.providerMessageReceipts.clear();
  await assert.rejects(run(), /already reserved/); assert.equal(effects, 1);
  const branch = { requestId: randomUUID(), kind: 'branch', itemId: 'synthetic-response' };
  let actions = 0;
  const branchRun = () => providerMessageReceipt({ sessions, source, request: branch, execute: async () => { actions++; return { session: { id: 'synthetic-child' } }; } });
  source.messageActionBusy = true;
  await assert.rejects(branchRun(), /current message action/); source.messageActionBusy = false;
  const result = await branchRun(); assert.equal(result.session.id, 'synthetic-child');
  source.providerMessageReceipts.clear(); assert.deepEqual(await branchRun(), result); assert.equal(actions, 1);
});
