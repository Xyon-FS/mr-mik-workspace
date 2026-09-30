import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexMetadata } from '../codex-metadata.mjs';
const id = '11111111-1111-4111-8111-111111111111';
test('bounded metadata parser reads large complete first records and BOM but never partial JSON', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-metadata-')), file = path.join(folder, 'fixture.jsonl');
  const record = JSON.stringify({ type: 'session_meta', payload: { id, instructions: 'fixture '.repeat(16000) } });
  await writeFile(file, '\uFEFF' + record + '\n{"type":"event_msg"}\n');
  assert.equal((await codexMetadata(file)).payload.id, id);
  await writeFile(file, record); assert.equal(await codexMetadata(file), null);
  assert.equal((await codexMetadata(file, { allowCompleteEof: true })).payload.id, id);
  await writeFile(file, record.slice(0, -5)); assert.equal(await codexMetadata(file, { allowCompleteEof: true }), null);
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, instructions: 'x'.repeat(2 * 1024 * 1024) } }) + '\n');
  assert.equal(await codexMetadata(file), null);
});
