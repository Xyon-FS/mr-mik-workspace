import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { cliHistoryModel, nativeRecordModel } from '../cli-model-history.mjs';

test('CLI resume model uses latest native metadata, never text or sidechain assistant models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-model-history-')), file = path.join(root, 'transcript.jsonl');
  const codexRecords = [
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { type: 'turn_context', payload: { model: 'gpt-6.1-terra' } },
    { type: 'event_msg', payload: { text: 'model: invented' } },
  ].map(JSON.stringify).join('\n');
  await writeFile(file, 'x'.repeat(600 * 1024) + '\n' + codexRecords + '\n{"type":');
  assert.equal(await cliHistoryModel(file, 'codex'), 'gpt-6.1-terra');
  assert.equal(await cliHistoryModel(path.join(root, 'missing'), 'codex'), null);
  await writeFile(file, [
    { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } },
    { type: 'user', message: { content: 'Set model to another' } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(await cliHistoryModel(file, 'claude'), 'claude-sonnet-5-5');
  assert.equal(nativeRecordModel({ type: 'assistant', message: { model: '<synthetic>' } }, 'claude'), null);
});
