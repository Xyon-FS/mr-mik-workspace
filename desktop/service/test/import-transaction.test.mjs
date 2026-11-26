import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { ImportTransaction } from '../import-transaction.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { randomUUID } from 'node:crypto';

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-import-transaction-'));
  const state = path.join(repo, '.mrmak'); await mkdir(state);
  const tx = new ImportTransaction(repo, state, path.join(state, 'import-backups', randomUUID()));
  await tx.initialize();
  return { repo, state, tx };
}

test('rollback restores replaced/deleted files and removes created files/directories', async () => {
  const { repo, tx, state } = await fixture();
  const existing = path.join(repo, 'existing.txt'), deleted = path.join(repo, 'deleted.txt');
  await writeFile(existing, 'original'); await writeFile(deleted, 'keep me');
  await tx.json(existing, { changed: true });
  await tx.remove(deleted);
  await tx.json(path.join(repo, 'new', 'nested', 'file.json'), { new: true });
  const next = new ImportTransaction(repo, state, path.join(state, 'import-backups', randomUUID()));
  await assert.rejects(next.initialize(), /interrupted import/);
  await tx.rollback();
  assert.equal(await readFile(existing, 'utf8'), 'original');
  assert.equal(await readFile(deleted, 'utf8'), 'keep me');
  assert.equal(await lstat(path.join(repo, 'new')).catch(() => null), null);
  assert.equal(JSON.parse(await readFile(path.join(tx.backup, 'transaction.json'))).status, 'rolled-back');
  await next.initialize();
  await next.json(path.join(repo, 'committed.json'), { value: 1 });
  await next.commit();
  const fresh = new ImportTransaction(repo, state, path.join(state, 'import-backups', randomUUID()));
  await fresh.initialize(); await fresh.rollback();
});

test('rollback preserves concurrent edits and blocks another import pending recovery', async () => {
  const { repo, state, tx } = await fixture();
  const existing = path.join(repo, 'existing.txt'); await writeFile(existing, 'original');
  await tx.json(existing, { changed: true });
  await writeFile(existing, 'external edit');
  await assert.rejects(tx.rollback(), /recovery requires review/);
  assert.equal(await readFile(existing, 'utf8'), 'external edit');
  const next = new ImportTransaction(repo, state, path.join(state, 'import-backups', randomUUID()));
  await assert.rejects(next.initialize(), /interrupted import requires recovery/);
});

test('native adapter attempts retain a recovery-required journal on outer failure', async () => {
  const { tx } = await fixture();
  await tx.externalWrite({ agent: 'opencode', id: 'ses_fixture', status: 'attempted' });
  await assert.rejects(tx.rollback(), /Native changes/);
  assert.equal(JSON.parse(await readFile(path.join(tx.backup, 'transaction.json'))).status, 'recovery-required');
});

test('full import failure restores existing Hub and native files and removes new files and History', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-import-failure-'));
  const previousHome = process.env.CODEX_HOME, hubs = [];
  try {
    for (const name of ['source', 'target']) {
      const repo = path.join(root, name), state = path.join(repo, '.mrmak');
      for (const folder of ['.mrmak', 'knowledge', 'workspace', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
      await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[],"resources":[]}');
      await writeFile(path.join(repo, 'projects', 'registry.json'), '{"projects":[]}');
      const sessions = await new Sessions(repo, state).init();
      hubs.push({ repo, state, sessions, archive: new PortableArchive(repo, state, sessions, null) });
    }
    const [source, target] = hubs;
    process.env.CODEX_HOME = path.join(root, 'source-codex');
    const conversations = [];
    for (const existing of [true, false]) {
      const id = randomUUID(), nativeId = randomUUID();
      const native = path.join('sessions', `rollout-fixture-${nativeId}.jsonl`);
      await mkdir(path.dirname(path.join(process.env.CODEX_HOME, native)), { recursive: true });
      const originalNative = JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: source.repo } }) + '\n';
      await writeFile(path.join(process.env.CODEX_HOME, native), originalNative + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'New fixture turn' }] } }) + '\n');
      source.sessions.items.set(id, source.sessions.make({ id, nativeId, agent: 'codex', cwd: source.repo, open: false, hasConversation: true }));
      await writeFile(path.join(source.state, `screen-${id}.json`), '{"data":"Fixture screen"}');
      conversations.push({ id, native, originalNative, existing });
    }
    await writeFile(path.join(source.repo, 'knowledge', 'existing.md'), 'incoming');
    await writeFile(path.join(source.repo, 'knowledge', 'new.md'), 'new');
    await writeFile(path.join(target.repo, 'knowledge', 'existing.md'), 'original');
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    process.env.CODEX_HOME = path.join(root, 'target-codex');
    const existing = conversations.find(conversation => conversation.existing);
    await mkdir(path.dirname(path.join(process.env.CODEX_HOME, existing.native)), { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, existing.native), existing.originalNative);
    const original = target.sessions.items;
    let notifications = 0; target.sessions.on('session', () => notifications++);
    target.sessions.hydrate = async () => { throw new Error('Injected hydration failure'); };
    await assert.rejects(target.archive.importFrom(exported.path, { replaceHub: ['knowledge/existing.md'] }), /Injected hydration failure/);
    assert.equal(await readFile(path.join(target.repo, 'knowledge', 'existing.md'), 'utf8'), 'original');
    assert.equal(await lstat(path.join(target.repo, 'knowledge', 'new.md')).catch(() => null), null);
    for (const { id, native, originalNative, existing } of conversations) {
      const nativeFile = path.join(process.env.CODEX_HOME, native);
      if (existing) assert.equal(await readFile(nativeFile, 'utf8'), originalNative);
      else assert.equal(await lstat(nativeFile).catch(() => null), null);
      assert.equal(await lstat(path.join(target.state, `screen-${id}.json`)).catch(() => null), null);
    }
    assert.equal(target.sessions.items, original); assert.equal(target.sessions.list().length, 0);
    assert.equal(notifications, 0);
    assert.equal(target.sessions.persistenceHolds, 0, 'A failed import releases the History save barrier');
    // A handled rollback permits a clean retry without inference or a restart.
    target.sessions.hydrate = async () => {};
    await target.archive.importFrom(exported.path, { replaceHub: ['knowledge/existing.md'] });
    assert.equal(target.sessions.list().length, conversations.length);
  } finally {
    await Promise.all(hubs.map(hub => hub.sessions.close()));
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});
