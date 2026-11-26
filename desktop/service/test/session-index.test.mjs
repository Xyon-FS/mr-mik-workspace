import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { loadSessionIndex, saveSessionIndex } from '../session-index.mjs';
import { Sessions } from '../sessions.mjs';
const item = { id: 'saved-chat', agent: 'codex', open: false };

test('History persistence holds drain prior saves, coalesce background writes and release independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-index-hold-'));
  const sessions = await new Sessions(root, root).init();
  const releases = []; let finishPending = () => {};
  try {
    await sessions.persist();
    const file = path.join(root, 'sessions.json'), before = await readFile(file, 'utf8');
    sessions.saveChain = new Promise(resolve => { finishPending = resolve; });
    let acquired = false;
    const acquiring = sessions.holdPersistence().then(release => { acquired = true; releases.push(release); return release; });
    await Promise.resolve(); assert.equal(acquired, false);
    finishPending(); const first = await acquiring;
    const second = await sessions.holdPersistence(); releases.push(second);
    sessions.items.set('held-shell', sessions.make({ id: 'held-shell', agent: 'shell', name: 'Held fixture', open: false }));
    await sessions.persist();
    assert.equal(await readFile(file, 'utf8'), before);
    first(); first(); assert.equal(sessions.persistenceHolds, 1);
    await sessions.persist(); assert.equal(await readFile(file, 'utf8'), before);
    second(); assert.equal(sessions.persistenceHolds, 0);
    assert.equal(sessions.dirty, true);
    await sessions.persist();
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].id, 'held-shell');
    sessions.saveChain = Promise.reject(new Error('Queued save failure fixture'));
    await assert.rejects(sessions.holdPersistence(), /Queued save failure fixture/);
    assert.equal(sessions.persistenceHolds, 0);
    await sessions.persist();
  } finally { finishPending(); for (const release of releases) release(); await sessions.close(); }
});
test('only a missing new History is empty; invalid shapes and duplicate identities fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'mik-index-shape-')), file = path.join(root,'sessions.json');
  assert.deepEqual(await loadSessionIndex(file),[]);
  for (const value of [{},[item,item],[{}]]) { await writeFile(file,JSON.stringify(value)); await assert.rejects(loadSessionIndex(file),/unreadable/); }

  const bytes = Buffer.alloc(100); await writeFile(file,bytes);
  const sessions = new Sessions(root, root);
  await assert.rejects(sessions.init(), /History index is unreadable/);
  await assert.rejects(sessions.persist(), /refusing to overwrite/);
  assert.deepEqual(await readFile(file), bytes);
});

test('recovery preserves corrupted primary bytes and does not resurrect intentionally empty History', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-index-evidence-')), file = path.join(root, 'sessions.json');
  await saveSessionIndex(file, [item]); await saveSessionIndex(file, [item]);
  const corrupt = Buffer.alloc(128); await writeFile(file, corrupt);
  const recovered = await loadSessionIndex(file); await saveSessionIndex(file, recovered);
  const evidence = (await readdir(root)).find(name => name.includes('.corrupt-'));
  assert.deepEqual(recovered, [item]);
  assert.ok(evidence); assert.deepEqual(await readFile(path.join(root, evidence)), corrupt);
  await saveSessionIndex(file, []); await saveSessionIndex(file, []);
  assert.deepEqual(await loadSessionIndex(file), []);
  assert.deepEqual(JSON.parse(await readFile(file + '.previous', 'utf8')), [item]);
});
