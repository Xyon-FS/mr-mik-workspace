// Opt-in native read-only check. Fake setup metadata is never used for logon or
// command execution. No setup RPC, real account, model call or ACL mutation.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { prepareCodexProfileLayout, codexProfileEnvironment } from '../codex-profile-layout.mjs';
import { NativeProfileProbe } from '../codex-profile-probe.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shadow-native-'));
const probes = [];
try {
  const sharedHome = path.join(root, 'common'), sqliteHome = path.join(root, 'sqlite');
  const sourceText = 'check_for_update_on_startup=false\n[windows]\nsandbox="elevated"\n[features]\napps=false\nprefer_mxc=false\nwindows_sandbox_service=false\n';
  const env = { ...process.env, HOME: root, USERPROFILE: root, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BRIDGE_TOKEN/.test(key)) delete env[key];
  for (const name of ['a', 'b']) {
    const layout = await prepareCodexProfileLayout({ privateHome: path.join(root, name), sharedHome, sqliteHome, sourceText, common: true });
    const probe = new NativeProfileProbe(root, codexProfileEnvironment(env, layout.privateHome, sqliteHome));
    probes.push(probe); await probe.initialize();
    assert.equal((await probe.rpc('windowsSandbox/readiness', null)).status, 'updateRequired');
  }
  await mkdir(path.join(sharedHome, '.sandbox-secrets'), { recursive: true });
  await writeFile(path.join(sharedHome, '.sandbox/setup_marker.json'), JSON.stringify({ version: 5, offline_username: 'SyntheticOffline', online_username: 'SyntheticOnline' }));
  await writeFile(path.join(sharedHome, '.sandbox-secrets/sandbox_users.json'), JSON.stringify({ version: 5, offline: { username: 'SyntheticOffline', password: 'never-decrypted' }, online: { username: 'SyntheticOnline', password: 'never-decrypted' } }));
  for (const probe of probes) assert.equal((await probe.rpc('windowsSandbox/readiness', null)).status, 'ready');
  await unlink(path.join(sharedHome, '.sandbox/setup_marker.json'));
  for (const probe of probes) assert.equal((await probe.rpc('windowsSandbox/readiness', null)).status, 'updateRequired');
  console.log('PASS: native readiness follows one canonical fixture sandbox across two auth overlays. No setup, logon, execution, model calls or ACL changes.');
} finally {
  await Promise.all(probes.map(probe => probe.close()));
  await cleanupFixtures();
}
