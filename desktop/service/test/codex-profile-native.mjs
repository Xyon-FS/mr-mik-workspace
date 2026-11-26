// Explicit native acceptance check, separate from the ordinary service suite.
// No login, model turn, MCP invocation or personal home is used by this script.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { prepareCodexProfileLayout, codexProfileEnvironment, withCodexStoreStartup } from '../codex-profile-layout.mjs';
import { NativeProfileProbe } from './codex-profile-probe.mjs';

export async function checkCodexProfiles() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-native-profiles-'));
  const sharedHome = path.join(root, 'shared'), sqliteHome = path.join(root, 'sqlite');
  await mkdir(sharedHome);
  await writeFile(path.join(sharedHome, 'instructions.md'), 'Synthetic offline configuration probe.');
  const sourceText = 'model_instructions_file="instructions.md"\n[plugins."synthetic@fixture"]\nenabled=false\n';
  const profiles = await Promise.all(['a', 'b'].map(name => prepareCodexProfileLayout({ privateHome: path.join(root, name), sharedHome, sqliteHome, sourceText, common: true })));
  const probes = [];
  try {
    const envs = profiles.map(profile => codexProfileEnvironment({ ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' }, profile.privateHome, profile.sqliteHome));
    // First bootstrap is serialized. The unguarded cold-start race was observed
    // during compatibility research; do not hide it behind a flaky pass/fail.
    await withCodexStoreStartup(sqliteHome, async () => {
      const bootstrap = new NativeProfileProbe(root, envs[0]); probes.push(bootstrap);
      try { await bootstrap.config(); } finally { await bootstrap.close(); }
    });
    // Start both before waiting: this exercises concurrency on initialized DBs.
    const concurrent = [];
    for (const env of envs) concurrent.push(new NativeProfileProbe(root, env));
    probes.push(...concurrent);
    const configs = await Promise.all(concurrent.map(probe => probe.config()));
    for (const config of configs) {
      assert.equal(config.cli_auth_credentials_store, 'file');
      assert.equal(path.resolve(config.sqlite_home).toLowerCase(), path.resolve(sqliteHome).toLowerCase());
    }
    const native = (await concurrent[0].rpc('config/read', { cwd: root })).config;
    assert.equal(path.resolve(native.model_instructions_file).toLowerCase(), path.join(sharedHome, 'instructions.md').toLowerCase());
    assert.equal(native.plugins['synthetic@fixture'].enabled, false);
    const accounts = await Promise.all(concurrent.map(probe => probe.account()));
    assert.ok(accounts.every(account => account === null), 'Synthetic homes must remain unauthenticated');
    // Each profile sees the same synthetic transcript and independent cache.
    await writeFile(path.join(profiles[0].privateHome, 'sessions', 'fixture.jsonl'), '{"synthetic":true}\n');
    assert.equal(await readFile(path.join(profiles[1].privateHome, 'sessions', 'fixture.jsonl'), 'utf8'), '{"synthetic":true}\n');
    for (const [index, profile] of profiles.entries()) await writeFile(path.join(profile.privateHome, 'models_cache.json'), JSON.stringify({ synthetic: index }));
    assert.notEqual(await readFile(path.join(profiles[0].privateHome, 'models_cache.json'), 'utf8'), await readFile(path.join(profiles[1].privateHome, 'models_cache.json'), 'utf8'));
    await Promise.all(probes.map(probe => probe.close()));
    const databases = (await readdir(sqliteHome)).filter(name => /\.sqlite$/.test(name));
    assert.ok(databases.includes('state_5.sqlite'), 'Installed Codex must create its configured state DB');
    for (const name of databases) {
      const db = new DatabaseSync(path.join(sqliteHome, name), { readOnly: true });
      try { assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']); }
      finally { db.close(); }
    }
    // Reopen both on the same store after shutdown, catching startup recovery.
    const reopened = envs.map(env => new NativeProfileProbe(root, env)); probes.push(...reopened);
    await Promise.all(reopened.map(probe => probe.config()));
    return { passed: true, nativeProcesses: 5, concurrentHomes: 2, serializedBootstrapRequired: true, commonConversationStore: true, sharedDatabaseIntegrity: true, databases, authenticatedAcceptance: 'pending-user-logins', modelRequests: 0 };
  } finally {
    const results = await Promise.allSettled(probes.map(probe => probe.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native profile processes did not close; fixtures retained.');
    await cleanupFixtures();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkCodexProfiles(), null, 2));
