import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { AccountProfiles } from '../account-profiles.mjs';
import { Accounts } from '../accounts.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { Coordinator } from '../coordinator.mjs';
import { readAccountIdentity } from '../account-identity.mjs';
import { CodexChatAdvanced } from '../codex-chat-advanced.mjs';
import { CodexChatOperations } from '../codex-chat-operations.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-identity-'));
  const home = path.join(root, 'system'), profilesRoot = path.join(root, 'accounts');
  await mkdir(home); await writeFile(path.join(home, 'config.toml'), 'model="fixture"\n');
  const profiles = new AccountProfiles({ root: profilesRoot, home: root, env: { CODEX_HOME: home } });
  const a = await profiles.create(), b = await profiles.create();
  const auth = async (id, user, suffix = '') => {
    const claims = Buffer.from(JSON.stringify({ sub: user, email: `${user}@example.test` })).toString('base64url');
    const file = path.join(profilesRoot, 'profiles', id, 'auth.json');
    await writeFile(file, JSON.stringify({ tokens: { account_id: `org-${user}`, id_token: `fixture.${claims}.fixture`, access_token: `synthetic-access-${suffix}`, refresh_token: `synthetic-refresh-${suffix}` } }));
    return file;
  };
  return { root, home, profilesRoot, profiles, a, b, auth };
}

test('identity binding detects drift and duplicates without persisting tokens; token refresh keeps the identity', async () => {
  const f = await fixture();
  await f.auth(f.a.id, 'one'); await f.auth(f.b.id, 'two');
  await assert.rejects(f.profiles.assertIdentity(f.a.id), /Verify or reconnect/);
  await f.profiles.bindIdentity(f.a.id, { existing: true }); await f.profiles.bindIdentity(f.b.id);
  await f.auth(f.a.id, 'one', 'refreshed');
  assert.equal((await f.profiles.assertIdentity(f.a.id)).identityState, 'verified');
  const registry = await readFile(path.join(f.profilesRoot, 'profiles.json'), 'utf8');
  assert.doesNotMatch(registry, /access_token|refresh_token|id_token|synthetic-access|synthetic-refresh/);
  await f.auth(f.b.id, 'one');
  await assert.rejects(f.profiles.assertIdentity(f.b.id), /changed unexpectedly/);
  await assert.rejects(f.profiles.assertIdentity(f.a.id), /more than once/);
  await assert.rejects(f.profiles.bindIdentity(f.b.id), /already connected/);
  await assert.rejects(f.profiles.bindIdentity(f.b.id, { existing: true }), /identity changed/);
  assert.equal((await f.profiles.registry()).profiles.find(item => item.id === f.b.id).identity.email, 'two@example.test');
  const invalid = await f.profiles.create();
  assert.equal(await readAccountIdentity(path.join(f.profilesRoot, 'profiles', invalid.id)), null);
  const file = await f.auth(invalid.id, 'invalid'); await writeFile(file, '{invalid');
  await assert.rejects(f.profiles.bindIdentity(invalid.id), /unreadable/);
  assert.equal((await f.profiles.identityStates()).find(row => row.id === invalid.id).identityState, 'unreadable');
});

test('completed silent login verifies identity; duplicate login is not accepted and the reservation releases', async () => {
  const f = await fixture(); await f.auth(f.a.id, 'one'); await f.profiles.bindIdentity(f.a.id);
  const accounts = new Accounts({ profiles: f.profiles, resolve: { codex: () => ({ file: 'synthetic.exe', args: [] }) }, launch: async (_command, env) => {
    assert.equal(env.CODEX_HOME, path.join(f.profilesRoot, 'profiles', f.b.id));
    await f.auth(f.b.id, 'one'); return { completed: true };
  } });
  try {
    const plan = await accounts.profilePlan(f.b.id, 'login');
    await assert.rejects(accounts.confirm(plan.token), /already connected/);
    assert.equal(await f.profiles.accountAction(), null);
    assert.equal((await f.profiles.registry()).profiles.find(item => item.id === f.b.id).identity, undefined);
  } finally { await accounts.close(); }
});

test('unverified logout never removes the association, verified logout removes only its profile', async () => {
  const f = await fixture(); let status = 'unknown';
  const accounts = new Accounts({ profiles: f.profiles, status: async () => status, resolve: { codex: () => ({ file: 'synthetic.exe', args: [] }) }, launch: async () => ({ completed: true }) });
  try {
    let plan = await accounts.profilePlan(f.b.id, 'logout', { disconnect: true });
    await assert.rejects(accounts.confirm(plan.token), /logout could not be verified/);
    assert.ok((await f.profiles.list()).some(item => item.id === f.b.id));
    status = 'logged-out'; plan = await accounts.profilePlan(f.b.id, 'logout', { disconnect: true }); await accounts.confirm(plan.token);
    assert.ok(!(await f.profiles.list()).some(item => item.id === f.b.id));
    assert.ok((await f.profiles.list()).some(item => item.id === f.a.id));
  } finally { await accounts.close(); }
});

test('graphical send and reused coordinator runtime reject changed identity before native execution', async () => {
  const blocked = async () => { throw new Error('Synthetic identity changed'); };
  await assert.rejects(CodexChat.prototype.submit.call({ verifyIdentity: blocked }), /Synthetic identity changed/);
  await assert.rejects(CodexChatAdvanced.prototype.steer.call({ runtime: { verifyIdentity: blocked } }), /Synthetic identity changed/);
  await assert.rejects(CodexChatOperations.prototype.start.call({ runtime: { verifyIdentity: blocked } }, 'review'), /Synthetic identity changed/);
  await assert.rejects(Coordinator.prototype.start.call({ verifyIdentity: blocked, child: {}, runtimeProfileId: 'fixture' }, 'fixture'), /Synthetic identity changed/);
});
