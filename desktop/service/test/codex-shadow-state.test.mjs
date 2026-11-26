import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, lstat, readdir, unlink, symlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { prepareCodexProfileLayout } from '../codex-profile-layout.mjs';
import { linkShadowRuntime } from '../codex-shadow-state.mjs';
import { AccountProfiles } from '../account-profiles.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shadow-state-'));
  return { root, sharedHome: path.join(root, 'common'), sqliteHome: path.join(root, 'store'), privateHome: path.join(root, 'account-a'), common: true };
}

test('version 2 runtime directories are retained once, never merged into canonical native state', async () => {
  const f = await fixture(); await prepareCodexProfileLayout(f);
  const metadataFile = path.join(f.privateHome, 'profile-layout.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')); metadata.version = 2;
  await writeFile(metadataFile, JSON.stringify(metadata));
  for (const name of ['.sandbox', '.sandbox-secrets', '.sandbox-bin']) {
    await unlink(path.join(f.privateHome, name)); await mkdir(path.join(f.privateHome, name));
    await writeFile(path.join(f.privateHome, name, 'local-synthetic'), 'Retain this fixture.');
    await writeFile(path.join(f.sharedHome, name, 'canonical-synthetic'), 'Canonical fixture.');
  }
  await prepareCodexProfileLayout(f);
  const entries = await readdir(f.privateHome);
  for (const name of ['.sandbox', '.sandbox-secrets', '.sandbox-bin']) {
    const retained = entries.find(item => item.startsWith(name + '-retained-'));
    assert.equal(await readFile(path.join(f.privateHome, retained, 'local-synthetic'), 'utf8'), 'Retain this fixture.');
    assert.equal(await lstat(path.join(f.sharedHome, name, 'local-synthetic')).catch(() => null), null);
  }
  const journal = JSON.parse(await readFile(path.join(f.privateHome, entries.find(name => name.startsWith('shadow-migration-'))), 'utf8'));
  assert.equal(journal.state, 'completed'); assert.equal(journal.toVersion, 3);
  await prepareCodexProfileLayout(f);
  assert.deepEqual(await readdir(f.privateHome), entries);
});

test('runtime preflight rejects wrong links before moving local directories; rollback restores retained state', async () => {
  const f = await fixture(); await mkdir(f.privateHome); await mkdir(f.sharedHome);
  await mkdir(path.join(f.privateHome, '.sandbox'));
  await writeFile(path.join(f.privateHome, '.sandbox', 'sentinel'), 'Keep');
  const wrong = path.join(f.root, 'wrong'); await mkdir(wrong);
  await symlink(wrong, path.join(f.privateHome, 'sqlite'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(linkShadowRuntime(f.privateHome, f.sharedHome, { version: 2 }), /link conflict/);
  assert.equal(await readFile(path.join(f.privateHome, '.sandbox', 'sentinel'), 'utf8'), 'Keep');
  await unlink(path.join(f.privateHome, 'sqlite'));
  const transaction = await linkShadowRuntime(f.privateHome, f.sharedHome, { version: 2 });
  await transaction.rollback();
  assert.equal((await lstat(path.join(f.privateHome, '.sandbox'))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(f.privateHome, '.sandbox', 'sentinel'), 'utf8'), 'Keep');
  assert.equal(await lstat(path.join(f.privateHome, 'sqlite')).catch(() => null), null);
});

test('active sessions defer an old profile migration without touching account authentication or directories', async () => {
  const f = await fixture(); await mkdir(f.sharedHome);
  const profiles = new AccountProfiles({ root: path.join(f.root, 'accounts'), home: f.root, env: { ...process.env, CODEX_HOME: f.sharedHome } });
  const account = await profiles.create('Synthetic'); const current = await profiles.context(account.id);
  const metadataFile = path.join(current.privateHome, 'profile-layout.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')); metadata.version = 2;
  await writeFile(metadataFile, JSON.stringify(metadata));
  await unlink(path.join(current.privateHome, '.sandbox')); await mkdir(path.join(current.privateHome, '.sandbox'));
  profiles.migrationBusy = () => true;
  await assert.rejects(profiles.context(account.id), /Close Codex chats/);
  assert.equal((await lstat(path.join(current.privateHome, '.sandbox'))).isSymbolicLink(), false);
  profiles.migrationBusy = () => false;
  await profiles.context(account.id);
  assert.equal((await lstat(path.join(current.privateHome, '.sandbox'))).isSymbolicLink(), true);
});

test('all old profiles are preflighted and upgraded before either account can launch', async () => {
  const f = await fixture(); await mkdir(f.sharedHome);
  const profiles = new AccountProfiles({ root: path.join(f.root, 'accounts'), home: f.root, env: { ...process.env, CODEX_HOME: f.sharedHome } });
  const a = await profiles.create('Synthetic A'), b = await profiles.create('Synthetic B');
  const contexts = [await profiles.context(a.id), await profiles.context(b.id)];
  for (const current of contexts) {
    const file = path.join(current.privateHome, 'profile-layout.json');
    const metadata = JSON.parse(await readFile(file, 'utf8')); metadata.version = 2;
    await writeFile(file, JSON.stringify(metadata));
    await unlink(path.join(current.privateHome, '.sandbox')); await mkdir(path.join(current.privateHome, '.sandbox'));
  }
  const wrong = path.join(f.root, 'wrong'); await mkdir(wrong);
  const secondLink = path.join(contexts[1].privateHome, 'sqlite');
  await unlink(secondLink); await symlink(wrong, secondLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(profiles.context(a.id), /link conflict/);
  assert.equal((await lstat(path.join(contexts[0].privateHome, '.sandbox'))).isSymbolicLink(), false);
  await unlink(secondLink);
  await profiles.context(a.id);
  for (const current of contexts) {
    assert.equal(JSON.parse(await readFile(path.join(current.privateHome, 'profile-layout.json'), 'utf8')).version, 3);
    assert.equal((await lstat(path.join(current.privateHome, '.sandbox'))).isSymbolicLink(), true);
  }
  profiles.migrationBusy = () => true;
  await profiles.context(b.id); // No migration remains when the first chat is active.
});

test('common settings changed after migration preflight reject before profile writes and a fresh retry succeeds', async () => {
  const f = await fixture(); await mkdir(f.sharedHome);
  const profiles = new AccountProfiles({ root: path.join(f.root, 'accounts'), home: f.root, env: { ...process.env, CODEX_HOME: f.sharedHome } });
  const a = await profiles.create('Synthetic A'), b = await profiles.create('Synthetic B');
  const contexts = [await profiles.context(a.id), await profiles.context(b.id)], files = contexts.map(context => path.join(context.privateHome, 'profile-layout.json'));
  for (const file of files) { const metadata = JSON.parse(await readFile(file, 'utf8')); metadata.version = 2; await writeFile(file, JSON.stringify(metadata)); }
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  profiles.beforeMigration = () => writeFile(path.join(f.sharedHome, 'config.toml'), 'model="changed-after-migration-preflight"\n');
  await assert.rejects(profiles.context(a.id), /changed while preparing/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  profiles.beforeMigration = null; await profiles.context(a.id);
  for (const context of contexts) {
    assert.equal(JSON.parse(await readFile(path.join(context.privateHome, 'profile-layout.json'), 'utf8')).version, 3);
    assert.match(await readFile(path.join(context.privateHome, 'config.toml'), 'utf8'), /changed-after-migration-preflight/);
  }
});
