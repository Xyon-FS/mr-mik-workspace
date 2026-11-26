import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, readdir, link, lstat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './fixtures.mjs';
import { recoverPreviousBootLease, leaseConversation } from '../conversation-lease.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-lease-recovery-'));
  const file = path.join(root, 'test.lock');
  const realNow = Date.now();
  // Simulate a boot after fixture creation without editing real boot state.
  t.mock.method(Date, 'now', () => realNow + 240000);
  const bootTime = realNow + 120000;
  const bytes = JSON.stringify({ owner: 'synthetic-owner', pid: 123456 });
  await writeFile(file, bytes);
  return { root, file, bootTime, bytes };
}

test('a proven previous-boot lease is archived and can be acquired once again', async t => {
  const f = await fixture(t);
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime, () => true), true);
  const evidence = (await readdir(f.root)).filter(name => name.includes('.recovered-'));
  assert.equal(evidence.length, 1);
  assert.equal(await readFile(path.join(f.root, evidence[0]), 'utf8'), f.bytes);
  await assert.rejects(lstat(f.file), { code: 'ENOENT' });
  const release = await leaseConversation({ sqliteHome: f.root }, '11111111-2222-3333-4444-555555555555');
  try { await assert.rejects(leaseConversation({ sqliteHome: f.root }, '11111111-2222-3333-4444-555555555555'), /already owned/); }
  finally { await release(); }
});

test('same-boot, unknown boot and surviving or reused owner PIDs stay locked', async t => {
  const f = await fixture(t);
  for (const bootTime of [null, NaN, 0, Date.now() + 1, f.bootTime - 240000]) {
    assert.equal(await recoverPreviousBootLease(f.file, bootTime, () => true), false);
  }
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime, () => false), false);
  const live = JSON.stringify({ owner: 'synthetic-live', pid: process.pid });
  await writeFile(f.file, live);
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime), false);
  assert.equal(await readFile(f.file, 'utf8'), live);
  assert.deepEqual(await readdir(f.root), ['test.lock']);
});

test('invalid evidence and multiply linked files are preserved', async t => {
  const f = await fixture(t);
  for (const bytes of ['\0\0', 'null', '{}', '{"owner":"synthetic","pid":-1}']) {
    await writeFile(f.file, bytes);
    assert.equal(await recoverPreviousBootLease(f.file, f.bootTime), false);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
  }
  await writeFile(f.file, f.bytes);
  await link(f.file, path.join(f.root, 'linked.lock'));
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime, () => true), false);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('an owner change during recovery is preserved rather than archived', async t => {
  const f = await fixture(t);
  const replacement = JSON.stringify({ owner: 'synthetic-replacement', pid: process.pid });
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime, () => {
    writeFileSync(f.file, replacement); return true;
  }), false);
  assert.equal(await readFile(f.file, 'utf8'), replacement);
  assert.deepEqual(await readdir(f.root), ['test.lock']);
});

test('concurrent recoveries archive once; a retained recovery guard fails closed', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => recoverPreviousBootLease(f.file, f.bootTime, () => true)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await readdir(f.root)).filter(name => name.includes('.recovered-')).length, 1);
  await writeFile(f.file, f.bytes);
  await writeFile(f.file + '.recovery', 'synthetic-existing-guard');
  assert.equal(await recoverPreviousBootLease(f.file, f.bootTime, () => true), false);
  assert.equal(await readFile(f.file + '.recovery', 'utf8'), 'synthetic-existing-guard');
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});
