import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readdir, readFile, symlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { acceptanceTranscript, createAcceptanceEnvironment, loadAcceptanceEnvironment, listAcceptanceEnvironments } from '../../../scripts/codex-account-acceptance.mjs';

test('cross-account test resume accepts only an unambiguous account A fixture, with no command/path injection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-acceptance-resume-'));
  const env = await createAcceptanceEnvironment(root), shared = env.profiles[0].sharedHome;
  const id = '11111111-2222-3333-4444-555555555555', file = path.join(shared, 'sessions', 'rollout-' + id + '.jsonl');
  const metadata = { type: 'session_meta', payload: { id, originator: 'mr_mik_account_acceptance_A' } };
  await writeFile(file, JSON.stringify(metadata) + '\n');
  assert.equal(await acceptanceTranscript(shared, id), id);
  for (const invalid of ['../auth.json', id + ';cmd', 'resume --last']) await assert.rejects(acceptanceTranscript(shared, invalid), /UUID/);
  metadata.payload.originator = 'unrelated-profile'; await writeFile(file, JSON.stringify(metadata) + '\n');
  await assert.rejects(acceptanceTranscript(shared, id), /exactly one/);
  metadata.payload.originator = 'mr_mik_account_acceptance_A'; await writeFile(file, JSON.stringify(metadata) + '\n');
  await mkdir(path.join(shared, 'sessions', 'duplicate'));
  await writeFile(path.join(shared, 'sessions', 'duplicate', path.basename(file)), JSON.stringify(metadata) + '\n');
  await assert.rejects(acceptanceTranscript(shared, id), /exactly one/);
});

test('retained environment discovery rejects changed store configuration and linked runs without touching their targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-acceptance-discovery-'));
  const [original, outside] = await Promise.all([createAcceptanceEnvironment(root), createAcceptanceEnvironment(root)]);
  assert.notEqual(original.root, outside.root);
  assert.notEqual(original.profiles[0].conversationStoreId, outside.profiles[0].conversationStoreId);
  assert.equal(original.profiles[0].conversationStoreId, original.profiles[1].conversationStoreId);
  for (const profile of [...original.profiles, ...outside.profiles]) assert.equal((await readdir(profile.privateHome)).includes('auth.json'), false);
  const config = path.join(original.profiles[0].privateHome, 'config.toml');
  const text = await readFile(config, 'utf8');
  await writeFile(config, text.replace('"file"', '"keyring"'));
  await assert.rejects(loadAcceptanceEnvironment(root, path.basename(original.root)), /layout-store-conflict/);
  assert.deepEqual((await listAcceptanceEnvironments(root)).map(run => run.name), [path.basename(outside.root)]);
  assert.equal(await readFile(config, 'utf8'), text.replace('"file"', '"keyring"'));
  const aliasName = 'run-11111111-2222-3333-4444-555555555555';
  await symlink(outside.root, path.join(root, aliasName), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await listAcceptanceEnvironments(root)).map(run => run.name), [path.basename(outside.root)]);
  await assert.rejects(loadAcceptanceEnvironment(root, aliasName), /directory-conflict/);
});
