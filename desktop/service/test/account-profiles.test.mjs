import test from 'node:test';
import { codexCommandFixture } from './cli-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { AccountProfiles } from '../account-profiles.mjs';
import { Accounts, runHiddenAccountCommand } from '../accounts.mjs';
import { leaseConversation } from '../conversation-lease.mjs';
import { Coordinator } from '../coordinator.mjs';
import { Sessions } from '../sessions.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-accounts-'));
  const home = path.join(base, 'os-home'), system = path.join(home, '.codex'), root = path.join(base, 'machine-accounts');
  await mkdir(system, { recursive: true });
  await writeFile(path.join(system, 'config.toml'), '# system stays unchanged\nmodel="fixture-model"\n');
  await writeFile(path.join(system, 'auth.json'), 'synthetic-system-login');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: system, CODEX_SQLITE_HOME: system, OPENAI_API_KEY: 'synthetic-env-key' };
  const profiles = new AccountProfiles({ root, home, env });
  return { base, root, home, system, env, profiles };
}

test('account display status never prepares or migrates a native runtime layout', async () => {
  const f = await fixture(), row = await f.profiles.create('Status fixture');
  f.profiles.context = async () => { throw new Error('Display must not prepare native layouts'); };
  let calls = 0;
  const accounts = new Accounts({profiles: f.profiles, status: async (_agent, _resolver, env) => {
    calls++; if (env.CODEX_HOME !== f.system) assert.equal(env.CODEX_HOME, path.join(f.root, 'profiles', row.id));
    return 'logged-out';
  }});
  try {
    const values = await accounts.profileInventory(); assert.equal(values.find(item => item.id === row.id).status, 'logged-out');
    assert.equal(values.find(item => item.id === row.id).available, true); assert.equal(calls, 1);
  } finally { await accounts.close(); }
});

test('native startup context rejects changed config and copied instructions until a fresh context is resolved', async () => {
  for (const change of ['common-config', 'private-config', 'instructions']) {
    const f = await fixture(), profile = await f.profiles.create('Native context revision'), initial = await f.profiles.context(profile.id);
    await f.profiles.assertCurrentContext(initial);
    if (change === 'common-config') await writeFile(path.join(f.system, 'config.toml'), 'model="new-startup-revision"\n');
    else if (change === 'private-config') await writeFile(path.join(initial.privateHome, 'config.toml'), (await readFile(path.join(initial.privateHome, 'config.toml'), 'utf8')) + '\n# external private edit\n');
    else {
      await writeFile(path.join(f.system, 'AGENTS.md'), 'New instructions copied by another launch.\n');
      await f.profiles.context(profile.id);
    }
    await assert.rejects(f.profiles.assertCurrentContext(initial), /configuration changed during startup/);
    const current = await f.profiles.context(profile.id); await f.profiles.assertCurrentContext(current);
  }
});

test('source or account changes while waiting for the disk lock reject before writing and release only their own lock', async () => {
  for (const change of ['source', 'removed']) {
    const f = await fixture(), profile = await f.profiles.create('Disk lock recovery'), privateHome = path.join(f.root, 'profiles', profile.id);
    const config = path.join(privateHome, 'config.toml'), metadata = path.join(privateHome, 'profile-layout.json'), lock = path.join(privateHome, '.mr-mik-layout.lock');
    const before = await Promise.all([readFile(config, 'utf8'), readFile(metadata, 'utf8')]);
    await writeFile(lock, 'review-held-lock', { flag: 'wx' });
    const upgrade = f.profiles.upgradeRuntimeLayouts.bind(f.profiles), validate = f.profiles.validatePreparation.bind(f.profiles);
    let upgrades = 0, queued = false, validations = 0;
    f.profiles.upgradeRuntimeLayouts = async (...args) => { await upgrade(...args); if (++upgrades === 2) queued = true; };
    f.profiles.validatePreparation = async (...args) => { validations++; return validate(...args); };
    const outcome = f.profiles.context(profile.id).then(value => ({ value }), error => ({ error }));
    let result;
    try {
      for (let i = 0; i < 400 && !queued; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(queued, true); assert.equal(validations, 0, 'freshness guard must run under the acquired lock');
      if (change === 'source') await writeFile(path.join(f.system, 'config.toml'), 'model="changed-during-lock-wait"\n');
      else await f.profiles.remove(profile.id);
    } finally {
      if (await readFile(lock, 'utf8').catch(() => null) === 'review-held-lock') await unlink(lock);
      result = await outcome;
    }
    assert.match(result.error?.message || '', /changed while preparing/);
    assert.deepEqual(await Promise.all([readFile(config, 'utf8'), readFile(metadata, 'utf8')]), before);
    await assert.rejects(readFile(lock), { code: 'ENOENT' }); assert.equal(f.profiles.preparing.size, 0);
    if (change === 'source') assert.match(await readFile(path.join((await f.profiles.context(profile.id)).privateHome, 'config.toml'), 'utf8'), /changed-during-lock-wait/);
  }
});

test('registry preserves the system account, isolates profile auth and shares configuration, shares native stores and exposes only safe references', async () => {
  const f = await fixture(), system = await f.profiles.context();
  assert.deepEqual(await f.profiles.list(), [{ id: 'system', label: 'System / current Codex', system: true }]);
  const a = await f.profiles.create('Personal'), b = await f.profiles.create('Work', { copySettings: true });
  const [ca, cb] = await Promise.all([f.profiles.context(a.id), f.profiles.context(b.id)]);
  assert.equal(ca.conversationStoreId, system.conversationStoreId); assert.equal(cb.conversationStoreId, system.conversationStoreId);
  assert.notEqual(ca.env.CODEX_HOME, cb.env.CODEX_HOME); assert.equal(ca.env.CODEX_SQLITE_HOME, f.system);
  assert.equal(ca.env.OPENAI_API_KEY, undefined); assert.equal(ca.env.USERPROFILE, f.home);
  assert.equal(system.env.OPENAI_API_KEY, 'synthetic-env-key');
  assert.equal((await readdir(ca.privateHome)).includes('auth.json'), false);
  assert.equal((await readFile(path.join(ca.privateHome, 'config.toml'), 'utf8')).includes('fixture-model'), true);
  assert.match(await readFile(path.join(cb.privateHome, 'config.toml'), 'utf8'), /fixture-model/);
  const inventory = JSON.stringify(await f.profiles.list());
  assert.ok(!inventory.includes(f.system) && !inventory.includes('synthetic'));
  await f.profiles.rename(a.id, 'Renamed'); assert.equal((await f.profiles.context(a.id)).label, 'Renamed');
  await f.profiles.remove(a.id); await assert.rejects(f.profiles.context(a.id), /missing/);
  assert.ok((await readdir(ca.privateHome)).includes('config.toml'), 'Removed associations retain native files');
  assert.equal(await readFile(path.join(f.system, 'auth.json'), 'utf8'), 'synthetic-system-login');
  assert.equal(await readFile(path.join(f.system, 'config.toml'), 'utf8'), '# system stays unchanged\nmodel="fixture-model"\n');
  await assert.rejects(f.profiles.context('../outside'), /Invalid/);
  await assert.rejects(f.profiles.create('bad\nname'), /profile name/);
});

test('profile-scoped account confirmations preserve other active accounts and reject stale profile config', async () => {
  const f = await fixture(), a = await f.profiles.create('A'), b = await f.profiles.create('B'), launched = [];
  const resolve = { codex: () => ({ file: 'fixture-codex.exe', args: [] }) };
  const accounts = new Accounts({ profiles: f.profiles, resolve, status: async () => 'logged-in', blocked: (_agent, id) => id === a.id, launch: async (command, env) => { launched.push({ command, env }); return { requested: true }; } });
  await assert.rejects(accounts.profilePlan(a.id, 'logout'), /Close/);
  const plan = await accounts.profilePlan(b.id, 'login');
  assert.equal(plan.isolated, true); assert.ok(!JSON.stringify(plan).includes('CODEX_HOME'));
  await accounts.confirm(plan.token); assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].command.args, ['-c', 'cli_auth_credentials_store="file"', 'login']);
  assert.equal(launched[0].env.CODEX_HOME, (await f.profiles.context(b.id)).privateHome);
  const stale = await accounts.profilePlan(b.id, 'logout');
  await writeFile(path.join(f.system, 'config.toml'), 'model="externally-edited"\n');
  await assert.rejects(accounts.confirm(stale.token), /configuration changed/); assert.equal(launched.length, 1);
});

test('single-writer lease spans service instances and never steals a retained or externally changed lock', async () => {
  const f = await fixture(), context = await f.profiles.context(), id = '11111111-2222-3333-4444-555555555555';
  const release = await leaseConversation(context, id);
  await assert.rejects(leaseConversation(context, id), /already owned/);
  await release(); await release(); const second = await leaseConversation(context, id); await second();
});

test('silent disconnect waits for native success, releases its lease and removes only the selected association', async () => {
  const f = await fixture(), a = await f.profiles.create('A'), b = await f.profiles.create('B');
  let finish, options;
  const accounts = new Accounts({ profiles: f.profiles, status: async () => 'logged-out', resolve: { codex: () => ({ file: 'fixture.exe', args: [] }) }, launch: async (_command, _env, value) => { options = value; await value.onStart(process.pid); await new Promise(resolve => { finish = resolve; }); return { completed: true }; } });
  const plan = await accounts.profilePlan(b.id, 'logout', { disconnect: true }), pending = accounts.confirm(plan.token);
  try {
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(options.silent, true); assert.equal(accounts.terminalOpen('codex', b.id), true);
    assert.ok((await f.profiles.list()).some(row => row.id === b.id));
    assert.equal((await f.profiles.accountAction()).profileId, b.id);
    finish(); await pending;
    assert.equal(await f.profiles.accountAction(), null);
    assert.ok((await f.profiles.list()).some(row => row.id === a.id));
    assert.ok(!(await f.profiles.list()).some(row => row.id === b.id));
    assert.equal(accounts.terminalOpen('codex', b.id), false);
  } finally { finish?.(); await pending.catch(() => {}); await accounts.close(); }
  const failure = new Accounts({ profiles: f.profiles, resolve: { codex: () => ({ file: 'fixture.exe', args: [] }) }, launch: async () => { throw new Error('synthetic failure'); } });
  try {
    const denied = await failure.profilePlan(a.id, 'logout', { disconnect: true });
    await assert.rejects(failure.confirm(denied.token), /synthetic failure/);
    assert.ok((await f.profiles.list()).some(row => row.id === a.id));
    assert.equal(await f.profiles.accountAction(), null);
  } finally { await failure.close(); }
});

test('service shutdown cancels its own hidden login and releases the machine reservation after process exit', async () => {
  const f = await fixture(), profile = await f.profiles.create('Pending');
  let started = false;
  const accounts = new Accounts({ profiles: f.profiles, resolve: { codex: () => ({ file: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] }) }, launch: (command, env, options) => runHiddenAccountCommand(command, env, { ...options, onStart: async pid => { await options.onStart(pid); started = true; } }) });
  const plan = await accounts.profilePlan(profile.id, 'login'), pending = accounts.confirm(plan.token);
  const rejected = assert.rejects(pending, /cancelled/);
  try {
    while (!started) await new Promise(resolve => setTimeout(resolve, 1));
    await accounts.close(); await rejected;
    assert.equal(accounts.pending.size, 0); assert.equal(await f.profiles.accountAction(), null);
    assert.ok((await f.profiles.list()).some(item => item.id === profile.id));
  } finally { await accounts.close(); await rejected; }
});

test('open chat account switching preflights login, rejects drafts and restarts only the selected idle terminal', async t => {
  await codexCommandFixture(t);
  const f = await fixture(), sessions = await new Sessions(f.base, path.join(f.base, 'switch-state')).init();
  let stops = 0, resumes = 0, empty = false, valid = true;
  const nativeId = '11111111-2222-3333-4444-555555555555';
  await mkdir(path.join(f.system, 'sessions'));
  await writeFile(path.join(f.system, 'sessions', `rollout-${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: f.base } }) + '\n');
  const listeners = new Set();
  const proc = { onExit(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; } };
  const session = sessions.make({ id: 'switch-chat', agent: 'codex', cwd: f.base, open: true, status: 'running', activity: 'idle', accountProfileId: 'system', process: null });
  session.process = proc; sessions.items.set(session.id, session);
  session.nativeId = nativeId; session.hasConversation = true;
  sessions.accountContext = async value => ({ profileId: value.accountProfileId, label: 'Selected', conversationStoreId: 'common', sharedHome: f.system, env: f.env });
  sessions.permissionReady = async () => empty;
  session.cliModelLabel = 'Confirmed source model';
  sessions.verifyAccount = async candidate => { candidate.cliModelLabel = 'Preflight metadata'; if (!valid) throw new Error('Fixture login unavailable'); };
  sessions.requestStop = selected => { assert.equal(selected, session); stops++; selected.process = null; for (const callback of [...listeners]) callback(); };
  sessions.resume = async (id, selectedNativeId) => { assert.equal(id, session.id); assert.equal(selectedNativeId, nativeId); resumes++; session.process = proc; };
  sessions.requireExplicitAccount = true;
  try {
    await assert.rejects(sessions.create({ agent: 'codex', cwd: f.base }), /added Codex account/);
    await assert.rejects(Sessions.prototype.resume.call(sessions, session.id), /added Codex account/);
    assert.throws(() => sessions.input(session.id, 'must not send'), /added Codex account/);
    await assert.rejects(sessions.setAccountProfile(session.id, 'system'), /added Codex account/);
    await assert.rejects(sessions.setAccountProfile(session.id, 'second'), /clear the draft/);
    empty = true; valid = false;
    await assert.rejects(sessions.setAccountProfile(session.id, 'second'), /login unavailable/);
    assert.equal(session.cliModelLabel, 'Confirmed source model', 'Rejected account preflight cannot overwrite the current CLI model');
    assert.equal(stops, 0); assert.equal(session.accountProfileId, 'system'); assert.equal(session.toolUpdating, false);
    valid = true;
    await sessions.setAccountProfile(session.id, 'second');
    assert.equal(stops, 1); assert.equal(resumes, 1); assert.equal(session.accountProfileId, 'second');
    session.activity = 'working';
    await assert.rejects(sessions.setAccountProfile(session.id, 'third'), /Finish/);
    assert.equal(stops, 1);
    session.activity = 'idle'; sessions.resume = async () => { session.cliModelLabel = 'Failed target model'; throw new Error('Fixture launch failed'); };
    await assert.rejects(sessions.setAccountProfile(session.id, 'third'), /launch failed/);
    assert.equal(session.cliModelLabel, 'Confirmed source model', 'Failed relaunch restores the source label');
    assert.equal(session.accountProfileId, 'second'); assert.equal(session.toolUpdating, false);
    session.accountProfileId = 'system'; session.process = null; session.open = true;
    sessions.resume = async (id, selectedNativeId) => { assert.equal(id, session.id); assert.equal(selectedNativeId, nativeId); resumes++; session.process = proc; };
    await sessions.setAccountProfile(session.id, 'second');
    assert.equal(session.accountProfileId, 'second'); assert.equal(resumes, 2);
  } finally { session.process = null; session.open = false; await sessions.close(); }
});

test('Mik rejects requests and model connections racing an account switch without recording or replaying a request', async () => {
  const f = await fixture(); let finish;
  const context = new Promise(resolve => { finish = resolve; });
  const coordinator = await new Coordinator({ repo: f.base, stateDir: path.join(f.base, 'mik-state'), execute: async () => assert.fail('No action should run'), accountContext: () => context, context: async () => ({}) }).init();
  try {
    const change = coordinator.setAccountProfile(null, undefined, 'fixture-profile');
    await assert.rejects(coordinator.ask({ id: 'racing-request', text: 'Must not send' }), /No message was sent/);
    await assert.rejects(coordinator.start(), /account change/);
    await assert.rejects(coordinator.setAccountProfile(null, undefined, 'another-profile'), /Wait/);
    finish({ profileId: 'fixture-profile', conversationStoreId: 'a'.repeat(64) });
    await change;
    assert.equal(coordinator.operations.size, 0); assert.equal(coordinator.child, null);
    assert.equal(coordinator.conversation(null).accountProfileId, 'fixture-profile');
  } finally { finish({ profileId: 'fixture-profile', conversationStoreId: 'a'.repeat(64) }); coordinator.close(); await coordinator.saves; }
});

test('service persists explicit profile selection, scopes Tools and rejects an active or incompatible conversation switch', async () => {
  const f = await fixture(), repo = path.join(f.base, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, profileOptions: { root: f.root, home: f.home, env: f.env }, mcpOptions: { home: f.home, env: f.env } });
  const request = async (route, data) => {
    const result = await fetch(service.origin + '/api' + route, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await result.json(); if (!result.ok) throw new Error(value.error); return value;
  };
  try {
    const profile = await request('/accounts/profiles', { action: 'create', label: 'Fixture account' });
    assert.equal((await request('/accounts/profiles?status=false')).length, 1);
    assert.ok((await request('/accounts/profiles?status=false')).every(row => !row.system));
    await assert.rejects(request('/sessions', { agent: 'codex', accountProfileId: 'system', cwd: repo }), /added Codex account/);
    await assert.rejects(request('/sessions', { agent: 'codex', accountProfileId: '', cwd: repo }), /added Codex account/);
    const item = service.sessions.make({ id: '11111111-2222-3333-4444-555555555555', agent: 'codex', name: 'Fixture chat', cwd: repo, open: false, status: 'stopped', nativeId: null });
    service.sessions.items.set(item.id, item);
    await request(`/sessions/${item.id}/account`, { profileId: profile.id });
    assert.equal(service.sessions.get(item.id).accountProfileId, profile.id);
    assert.equal((await request('/history'))[0].accountProfileId, profile.id);
    item.open = true; await assert.rejects(request(`/sessions/${item.id}/account`, { profileId: 'system' }), /added Codex account/); item.open = false;
    const scopes = await request('/codex/scopes?profileId=' + profile.id);
    assert.equal(scopes.globalFile, path.join(f.system, 'config.toml'));
    const editor = await request('/codex/mcp-managed?scope=global&profileId=' + profile.id);
    assert.equal(editor.file, path.join(f.system, 'config.toml'));
    const mik = await request('/coordinator/conversation', { action: 'account', profileId: profile.id });
    assert.equal(mik.accountProfileId, profile.id);
    assert.equal((await request('/coordinator')).accountProfileId, profile.id);
    const storedMik = JSON.parse(await readFile(path.join(repo, '.mrmak', 'mak-conversations.json'), 'utf8'));
    assert.equal(storedMik.conversations[0].accountProfileId, profile.id);
    await request('/accounts/profiles', { action: 'remove', id: profile.id });
    await assert.rejects(service.sessions.accountContext(item), /missing/);
    assert.equal(item.accountProfileId, profile.id);
    const persisted = JSON.parse(await readFile(path.join(repo, '.mrmak', 'sessions.json'), 'utf8'));
    assert.equal(persisted[0].accountProfileId, profile.id); assert.ok(!JSON.stringify(persisted).includes('synthetic'));
  } finally { await service.close(); }
});
