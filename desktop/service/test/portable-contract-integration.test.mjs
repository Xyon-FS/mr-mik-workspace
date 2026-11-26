import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { ImportTransaction } from '../import-transaction.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-contract-roundtrip-')), hubs = [];
  const hub = async name => {
    const repo = path.join(root, name), state = path.join(repo, '.mrmak');
    for (const folder of ['.mrmak', 'knowledge', 'workspace', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
    await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
    const sessions = await new Sessions(repo, state).init();
    const value = { repo, state, sessions, archive: new PortableArchive(repo, state, sessions, null) };
    hubs.push(value); return value;
  };
  const source = await hub('source');
  const parent = { id: randomUUID(), nativeId: randomUUID(), agent: 'codex', cwd: source.repo, open: false, hasConversation: true };
  const child = { ...parent, id: randomUUID(), nativeId: randomUUID(), chatInterface: 'chat', messageOrigin: { sessionId: parent.id, threadId: parent.nativeId, itemId: 'fixture-item', kind: 'branch' } };
  for (const session of [child, parent]) source.sessions.items.set(session.id, source.sessions.make(session));
  await writeFile(path.join(source.repo, 'knowledge/incoming.md'), 'Fixture content');
  const exported = await source.archive.exportTo(root, { chats: 'light' });
  const rewrite = async (name, change, rows) => {
    const entries = unzipSync(await readFile(exported.path));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    if (rows) {
      const key = 'state/sessions.json'; entries[key] = strToU8(JSON.stringify(rows));
      Object.assign(manifest.files.find(file => file.name === key), { size: entries[key].length, sha256: createHash('sha256').update(entries[key]).digest('hex') });
    }
    change(manifest); entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    const file = path.join(root, `${name}.mrmak.zip`); await writeFile(file, zipSync(entries)); return file;
  };
  return { root, hub, source, parent, child, rewrite, exported, close: async () => { await Promise.all(hubs.map(value => value.sessions.close())); } };
}

test('legacy and future optional archives round-trip while invalid contracts fail before writes', async () => {
  const f = await fixture();
  try {
    for (const mode of ['legacy', 'optional']) {
      const file = await f.rewrite(mode, manifest => { if (mode === 'legacy') delete manifest.transfer; else manifest.transfer.features.push('future-optional-feature'); });
      const target = await f.hub(mode);
      await target.archive.importFrom(file); await target.archive.importFrom(file);
      assert.equal(target.sessions.list().length, 2);
      assert.equal(target.sessions.get(f.child.id).messageOrigin.sessionId, f.parent.id);
      assert.equal(target.sessions.get(f.child.id).messageOrigin.unavailable, false);
      assert.equal(await readFile(path.join(target.repo, 'knowledge/incoming.md'), 'utf8'), 'Fixture content');
    }
    for (const mode of ['required', 'duplicates', 'unknown-version', 'invalid-mode']) {
      const file = await f.rewrite(mode, manifest => {
        if (mode === 'required') manifest.transfer.required.push('future-required-feature');
        if (mode === 'unknown-version') manifest.transfer.version = 99;
        if (mode === 'invalid-mode') manifest.chats = 'unexpected';
      }, mode === 'duplicates' ? [f.parent, f.parent] : undefined);
      const target = await f.hub(mode);
      const errors = { required: /unsupported transfer features/, duplicates: /duplicate chat metadata/, 'unknown-version': /Invalid archive transfer contract/, 'invalid-mode': /transfer mode/ };
      await assert.rejects(target.archive.importFrom(file), errors[mode]);
      assert.equal(target.sessions.list().length, 0);
      assert.equal(await lstat(path.join(target.repo, 'knowledge/incoming.md')).catch(() => null), null);
      assert.equal(await lstat(path.join(target.state, 'import-backups')).catch(() => null), null);
    }
  } finally { await f.close(); }
});

test('missing original stays explicit; importing its parent later repairs the persisted link', async () => {
  const f = await fixture();
  const commit = ImportTransaction.prototype.commit;
  try {
    const childOnly = await f.rewrite('child', () => {}, [f.child]);
    const parentOnly = await f.rewrite('parent', () => {}, [f.parent]);
    const target = await f.hub('missing-parent');
    await target.archive.importFrom(childOnly);
    assert.equal(target.sessions.get(f.child.id).messageOrigin.sessionId, null);
    assert.equal(target.sessions.get(f.child.id).messageOrigin.unavailable, true);
    const localId = randomUUID();
    target.sessions.items.set(localId, target.sessions.make({ ...f.parent, id: localId, nativeId: randomUUID(), cwd: target.repo, name: 'Local history' }));
    await target.sessions.persist();
    let invoked = false;
    ImportTransaction.prototype.commit = async function () {
      if (this.repo === target.repo) { invoked = true; await target.sessions.persist(); }
      return commit.call(this);
    };
    await target.archive.importFrom(parentOnly);
    assert.equal(invoked, true);
    assert.equal(target.sessions.get(f.child.id).messageOrigin.sessionId, f.parent.id);
    assert.equal(target.sessions.get(f.child.id).messageOrigin.unavailable, false);
    const stored = JSON.parse(await readFile(path.join(target.state, 'sessions.json'), 'utf8'));
    assert.equal(stored.find(item => item.id === f.child.id).messageOrigin.sessionId, f.parent.id);
    assert.deepEqual(stored.map(item => item.id).sort(), [localId, f.child.id, f.parent.id].sort());
    assert.equal(target.sessions.list().length, 3);
  } finally { ImportTransaction.prototype.commit = commit; await f.close(); }
});
