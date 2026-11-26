import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp } from './fixtures.mjs';
import { CodexCliVerifier, cliVerifierKey } from '../codex-cli-verifier.mjs';

async function fixture(t, options = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-cli-verifier-')), probes = [];
  const verifier = new CodexCliVerifier({ binary: () => ({ file: process.execPath, args: [] }), key: async ({ account }) => account.key, createProbe: () => {
    const probe = { reads: 0, closed: false, pending: [], async config() { this.reads++; if (this.hold) await new Promise((resolve, reject) => this.pending.push({ resolve, reject })); if (this.exited) throw new Error('Fixture probe exited'); return { valid: true }; }, async account() { this.reads++; return { type: 'chatgpt' }; }, async close() { this.closed = this.closing = this.exited = true; for (const pending of this.pending.splice(0)) pending.reject(new Error('Fixture probe closed')); } };
    probes.push(probe); return probe;
  }, ...options });
  t.after(() => verifier.close());
  const account = { key: 'A', profileId: 'A', sqliteHome: folder, env: {} };
  const check = async probe => { assert.equal((await probe.config()).valid, true); assert.equal((await probe.account()).type, 'chatgpt'); };
  return { folder, probes, verifier, account, check };
}

test('serializes concurrent verifications without coalescing their identity checks', async t => {
  const f = await fixture(t); let active = 0, maximum = 0, checks = 0;
  const check = async probe => { checks++; maximum = Math.max(maximum, ++active); try { await delay(5); await f.check(probe); } finally { active--; } };
  await Promise.all(Array.from({ length: 4 }, () => f.verifier.verify(f.account, f.folder, check)));
  assert.equal(maximum, 1); assert.equal(checks, 4); assert.equal(f.probes.length, 1); assert.equal(f.probes[0].reads, 8);
  await f.verifier.verify({ ...f.account, key: 'B', profileId: 'B' }, f.folder, f.check);
  assert.equal(f.probes.length, 2);
  assert.equal(f.probes[0].closed, true);
  const other = { ...f.account, key: 'B', profileId: 'B' };
  let failures = 0;
  await assert.rejects(f.verifier.verify(other, f.folder, async () => { failures++; throw new Error('Identity mismatch'); }), /Identity mismatch/);
  assert.equal(failures, 1); assert.equal(f.probes[1].closed, true);
  await f.verifier.verify(other, f.folder, f.check);
  assert.equal(f.probes.length, 3);
});

test('invalidation interrupts a pending read and rejects queued old-generation checks', async t => {
  const f = await fixture(t); await f.verifier.verify(f.account, f.folder, f.check); f.probes[0].hold = true;
  const first = f.verifier.verify(f.account, f.folder, f.check), firstRejected = assert.rejects(first, /closed|cancelled/);
  for (let i = 0; i < 100 && !f.probes[0].pending.length; i++) await delay(2);
  assert.equal(f.probes[0].pending.length, 1);
  const second = f.verifier.verify(f.account, f.folder, f.check), secondRejected = assert.rejects(second, /cancelled/);
  await f.verifier.invalidate(); await firstRejected; await secondRejected;
  assert.equal(f.verifier.entry, null); await f.verifier.verify({ ...f.account, key: 'B' }, f.folder, f.check);
  assert.equal(f.probes.length, 2);
});

test('shutdown cancels waiting store-lock acquisition without deleting its other owner', async t => {
  const f = await fixture(t), file = path.join(f.folder, '.mr-mik-startup.lock');
  await writeFile(file, 'other-owner');
  const checking = f.verifier.verify(f.account, f.folder, f.check), rejected = assert.rejects(checking, /cancelled/);
  await delay(10); await f.verifier.close(); await rejected;
  assert.equal(f.probes.length, 0); assert.equal(await readFile(file, 'utf8'), 'other-owner');
  await assert.rejects(f.verifier.verify(f.account, f.folder, f.check), /cancelled/);
});

test('an expired timer queued during a lock wait cannot retire the newly refreshed verifier', async t => {
  const f = await fixture(t, { idleTtlMs: 80 }); await f.verifier.verify(f.account, f.folder, f.check);
  const file = path.join(f.folder, '.mr-mik-startup.lock'); await writeFile(file, 'other-owner');
  const next = f.verifier.verify(f.account, f.folder, f.check); await delay(100); await unlink(file);
  await next; await f.verifier.tail;
  assert.equal(f.probes.length, 1); assert.equal(f.probes[0].closed, false);
});

test('key changes for auth, private/project configuration, directory, environment and executable identity', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mik-verifier-key-')), home = path.join(folder, 'profile'), cwd = path.join(folder, 'work');
  await mkdir(home); await mkdir(path.join(cwd, '.codex'), { recursive: true });
  await writeFile(path.join(home, 'auth.json'), 'synthetic-auth'); await writeFile(path.join(home, 'config.toml'), 'model="fixture"');
  const account = { profileId: 'A', privateHome: home, conversationStoreId: 'store', configRevision: 'config', env: { PATH: 'fixture' } }, binary = { file: process.execPath, args: [] };
  const initial = await cliVerifierKey({ account, cwd, binary });
  for (const changed of [{ account: { ...account, profileId: 'B' } }, { cwd: folder }, { account: { ...account, env: { PATH: 'different' } } }, { binary: { ...binary, args: ['alternate'] } }]) assert.notEqual(await cliVerifierKey({ account, cwd, binary, ...changed }), initial);
  await writeFile(path.join(home, 'auth.json'), 'changed-auth'); const auth = await cliVerifierKey({ account, cwd, binary }); assert.notEqual(auth, initial);
  await writeFile(path.join(home, 'config.toml'), 'model="changed"'); const config = await cliVerifierKey({ account, cwd, binary }); assert.notEqual(config, auth);
  await writeFile(path.join(cwd, '.codex/config.toml'), 'model="project"'); assert.notEqual(await cliVerifierKey({ account, cwd, binary }), config);
  const executable = path.join(folder, 'fixture.exe'); await writeFile(executable, 'one'); const first = await cliVerifierKey({ account, cwd, binary: { file: executable, args: [] } });
  await writeFile(executable, 'replacement'); assert.notEqual(await cliVerifierKey({ account, cwd, binary: { file: executable, args: [] } }), first);
  const script = path.join(folder, 'wrapper.js'); await writeFile(script, 'initial wrapper');
  const wrapper = { file: process.execPath, args: [script] }, before = await cliVerifierKey({ account, cwd, binary: wrapper });
  await writeFile(script, 'updated wrapper'); assert.notEqual(await cliVerifierKey({ account, cwd, binary: wrapper }), before);
});
