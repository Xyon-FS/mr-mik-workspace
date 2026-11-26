import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, symlink, link, rename, lstat, readdir, realpath } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { mkdtemp } from './fixtures.mjs';
import { codexProfileEnvironment, prepareCodexProfileLayout, projectCodexProfileConfig, withCodexStoreStartup } from '../codex-profile-layout.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-profile-layout-'));
  return { root, privateHome: path.join(root, 'profile-a'), sharedHome: path.join(root, 'shared'), sqliteHome: path.join(root, 'sqlite') };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('two private homes share transcripts/store identity while auth/model caches and OS home remain independent', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([prepareCodexProfileLayout(f), prepareCodexProfileLayout({ ...f, privateHome: path.join(f.root, 'profile-b') })]);
  assert.equal(a.conversationStoreId, b.conversationStoreId);
  assert.notEqual(a.privateHome, b.privateHome);
  assert.deepEqual(a.sharedDirectories, ['sessions', 'archived_sessions']);
  for (const name of a.sharedDirectories) assert.equal(await realpath(path.join(a.privateHome, name)), await realpath(path.join(b.privateHome, name)));
  await writeFile(path.join(a.privateHome, 'sessions', 'synthetic.jsonl'), '{"fixture":true}\n');
  assert.match(await readFile(path.join(b.privateHome, 'sessions', 'synthetic.jsonl'), 'utf8'), /fixture/);
  // These are synthetic sentinels, never tokens or real authentication data.
  await writeFile(path.join(a.privateHome, 'auth.json'), 'synthetic-a');
  await writeFile(path.join(b.privateHome, 'auth.json'), 'synthetic-b');
  await writeFile(path.join(a.privateHome, 'models_cache.json'), 'model-a');
  await writeFile(path.join(b.privateHome, 'models_cache.json'), 'model-b');
  await prepareCodexProfileLayout(f);
  assert.equal(await readFile(path.join(b.privateHome, 'auth.json'), 'utf8'), 'synthetic-b');
  assert.equal(await readFile(path.join(b.privateHome, 'models_cache.json'), 'utf8'), 'model-b');
  assert.equal((await readdir(f.sharedHome)).includes('auth.json'), false);
  assert.equal((await lstat(path.join(a.privateHome, 'config.toml'))).isSymbolicLink(), false);
  const base = { HOME: 'os-home', USERPROFILE: 'os-user', OPENAI_API_KEY: 'synthetic', access_token: 'synthetic', CODEX_HOME: 'ambient', codex_sqlite_home: 'ambient', PATH: 'unchanged', CLAUDE_CONFIG_DIR: 'unchanged' };
  const env = codexProfileEnvironment(base, a.privateHome, a.sqliteHome);
  assert.equal(env.CODEX_HOME, a.privateHome); assert.equal(env.CODEX_SQLITE_HOME, a.sqliteHome);
  assert.equal(env.HOME, base.HOME); assert.equal(env.USERPROFILE, base.USERPROFILE);
  assert.equal(env.CLAUDE_CONFIG_DIR, base.CLAUDE_CONFIG_DIR); assert.equal(env.PATH, base.PATH);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.access_token, undefined);
  assert.equal(env.codex_sqlite_home, undefined); assert.equal(base.CODEX_HOME, 'ambient');
});

test('projection preserves reviewed settings and rejects unknown/path-sensitive semantics rather than guessing', async () => {
  const f = await fixture();
  const source = `# Original comments remain in the original file\nmodel="fixture-model"\n[projects.${JSON.stringify(f.root)}]\ntrust_level="trusted"\n[mcp_servers.local]\ncommand="node"\nargs=["relative-script.mjs"]\ncwd=${JSON.stringify(f.root)}\nenv={FIXTURE_SECRET="synthetic-private"}\n`;
  const result = parse(projectCodexProfileConfig(source, f.sqliteHome));
  assert.equal(result.model, 'fixture-model'); assert.equal(result.sqlite_home, f.sqliteHome);
  assert.equal(result.cli_auth_credentials_store, 'file');
  assert.equal(result.mcp_servers.local.env.FIXTURE_SECRET, 'synthetic-private');
  assert.equal(result.mcp_servers.local.cwd, f.root);
  for (const [sourceText, code] of [
    ['[malformed', 'malformed-configuration'],
    ['unknown_native_setting=true', 'unsupported-configuration'],
    ['model_instructions_file="relative.md"', 'unsupported-configuration'],
    ['[mcp_servers.local]\ncwd="relative"', 'relative-configuration-path'],
    ['[mcp_servers.local]\ncommand="./relative.exe"', 'relative-configuration-path'],
    ['[skills]\nconfig=[{path="relative",enabled=false}]', 'relative-configuration-path'],
    ['[plugins."browser@openai-bundled"]\nenabled=true', 'shared-plugin-layout-unverified'],
    ['cli_auth_credentials_store="keyring"', 'unsupported-credential-store'],
    ['sqlite_home="relative"', 'relative-configuration-path'],
    [`sqlite_home=${JSON.stringify(f.root)}`, 'sqlite-store-conflict'],
  ]) assert.throws(() => projectCodexProfileConfig(sourceText, f.sqliteHome), error => error.code === code);
  assert.throws(() => projectCodexProfileConfig('x'.repeat(1024 * 1024 + 1), f.sqliteHome), /configuration-too-large/);
});

test('source updates are atomic and native edits are retained with an explicit conflict', async () => {
  const f = await fixture(), source = path.join(f.root, 'system.toml');
  const unowned = { ...f, privateHome: path.join(f.root, 'unowned') };
  await mkdir(unowned.privateHome);
  const unownedConfig = path.join(unowned.privateHome, 'config.toml');
  await writeFile(unownedConfig, '# unrelated\n');
  await rejects(prepareCodexProfileLayout(unowned), 'external-configuration-edit');
  assert.equal(await readFile(unownedConfig, 'utf8'), '# unrelated\n');
  await writeFile(source, '# original\nmodel="first"\n');
  const a = await prepareCodexProfileLayout({ ...f, sourceText: await readFile(source, 'utf8') });
  const b = await prepareCodexProfileLayout({ ...f, sourceText: 'model="second"\n' });
  assert.equal(a.conversationStoreId, b.conversationStoreId);
  assert.notEqual(a.configRevision, b.configRevision);
  assert.equal(parse(await readFile(path.join(f.privateHome, 'config.toml'), 'utf8')).model, 'second');
  assert.equal(await readFile(source, 'utf8'), '# original\nmodel="first"\n');
  const nativeEdit = 'model="native-local-choice"\n';
  const temporary = path.join(f.privateHome, 'native-edit.tmp');
  await writeFile(temporary, nativeEdit); await rename(temporary, path.join(f.privateHome, 'config.toml'));
  await rejects(prepareCodexProfileLayout(f), 'external-configuration-edit');
  assert.equal(await readFile(path.join(f.privateHome, 'config.toml'), 'utf8'), nativeEdit);
  assert.equal((await readdir(f.privateHome)).some(name => name.endsWith('.tmp') || name === '.mr-mik-layout.lock'), false);
  await rejects(prepareCodexProfileLayout({ ...f, sqliteHome: path.join(f.root, 'new-store') }), 'layout-store-conflict');
  await writeFile(path.join(f.privateHome, '.mr-mik-layout.lock'), 'another-writer');
  await rejects(prepareCodexProfileLayout(f), 'profile-busy');
  assert.equal(await readFile(path.join(f.privateHome, '.mr-mik-layout.lock'), 'utf8'), 'another-writer');
});

test('wrong junctions, hardlinked private files, overlapping homes and symlinked ancestors fail closed', async () => {
  const f = await fixture();
  await rejects(prepareCodexProfileLayout({ ...f, privateHome: path.join(f.sharedHome, 'nested') }), 'overlapping-homes');
  await rejects(prepareCodexProfileLayout({ ...f, privateHome: f.sqliteHome }), 'overlapping-homes');
  await mkdir(f.privateHome); const wrong = path.join(f.root, 'wrong'); await mkdir(wrong);
  await symlink(wrong, path.join(f.privateHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(prepareCodexProfileLayout(f), 'shared-directory-conflict');
  assert.deepEqual(await readdir(wrong), []);
  assert.equal((await readdir(f.privateHome)).includes('config.toml'), false);
  const other = { ...f, privateHome: path.join(f.root, 'other') }; await mkdir(other.privateHome);
  const sentinel = path.join(f.root, 'sentinel'); await writeFile(sentinel, 'do-not-change');
  await link(sentinel, path.join(other.privateHome, 'auth.json'));
  await rejects(prepareCodexProfileLayout(other), 'private-file-conflict');
  assert.equal(await readFile(sentinel, 'utf8'), 'do-not-change');
  const alias = path.join(f.root, 'alias'); await symlink(wrong, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(prepareCodexProfileLayout({ ...f, privateHome: path.join(alias, 'private') }), 'directory-conflict');
  assert.deepEqual(await readdir(wrong), []);
});

test('startup lease serializes competing callers, releases after failure and refuses a retained owner', async () => {
  const f = await fixture(), sequence = [];
  const run = name => withCodexStoreStartup(f.sqliteHome, async () => { sequence.push(name); await new Promise(resolve => setTimeout(resolve, 60)); sequence.push(name + '-done'); });
  await Promise.all([run('a'), run('b')]);
  assert.ok(JSON.stringify(sequence) === '["a","a-done","b","b-done"]' || JSON.stringify(sequence) === '["b","b-done","a","a-done"]');
  await assert.rejects(withCodexStoreStartup(f.sqliteHome, async () => { throw new Error('synthetic-failure'); }), /synthetic-failure/);
  assert.equal((await readdir(f.sqliteHome)).includes('.mr-mik-startup.lock'), false);
  await writeFile(path.join(f.sqliteHome, '.mr-mik-startup.lock'), 'retained-owner');
  await rejects(withCodexStoreStartup(f.sqliteHome, async () => assert.fail('must not start'), { timeoutMs: 0 }), 'conversation-store-startup-busy');
  assert.equal(await readFile(path.join(f.sqliteHome, '.mr-mik-startup.lock'), 'utf8'), 'retained-owner');
});
