import test from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, accountCommand, accountStatusCommand, parseAccountStatus, parseOpenCodeProviders } from '../accounts.mjs';

const resolve = Object.fromEntries(['codex', 'claude', 'opencode'].map(agent => [agent, () => ({ file: `C:/Fixture/${agent}.exe`, args: [] })]));
test('provider inventory projects only safe identities and connection state; native picker handles unknown V1 identities', async () => {
  const details = { code: 0, stdout: JSON.stringify([{ id: 'anthropic', name: 'Private account', connections: [{ type: 'credential', label: 'private@example.com', token: 'secret' }] }, { id: 'google', connections: [{ type: 'environment', name: 'PRIVATE_KEY' }] }]) };
  const result = parseOpenCodeProviders(details);
  assert.deepEqual(result, { status: 'logged-in', providers: [{ provider: 'anthropic', label: 'anthropic', status: 'logged-in', canLogout: true }, { provider: 'google', label: 'google', status: 'logged-in', canLogout: false }] });
  assert.ok(!/Private|private|secret|KEY/.test(JSON.stringify(result)));
  assert.deepEqual(parseOpenCodeProviders({ code: 0, stdout: 'Credentials\n● Anthropic api\n● OpenAI oauth\n2 credentials' }).providers.map(row => row.provider), ['', '']);
  assert.equal(parseOpenCodeProviders({ code: 1, stdout: details.stdout }).status, 'unknown');
  assert.equal(parseOpenCodeProviders({ code: 0, stdout: '[{"id":"bad;command","connections":[]}]' }).status, 'unknown');
  assert.deepEqual(accountCommand('opencode', 'login', resolve, '').args, ['auth', 'login']);
  const v2 = { ...resolve, openCodeFamily: () => 2 };
  assert.deepEqual(accountCommand('opencode', 'logout', v2, 'anthropic').args, ['auth', 'logout', 'anthropic', '--standalone']);
  assert.throws(() => accountCommand('opencode', 'login', v2, 'x; dangerous'), /provider/);
  const launches = [], accounts = new Accounts({ resolve: v2, status: async agent => agent === 'opencode' ? result : 'unknown', launch: async command => launches.push(command) });
  const inventory = await accounts.inventory(); assert.deepEqual(inventory[2].providers, result.providers);
  const plan = accounts.plan('opencode', 'logout', 'anthropic'); assert.match(plan.label, /anthropic/); await accounts.confirm(plan.token);
  assert.deepEqual(launches[0].args, ['auth', 'logout', 'anthropic', '--standalone']);
});
test('account controls use exact native commands, never prompts or untrusted command parameters', () => {
  assert.deepEqual(accountCommand('codex', 'logout', resolve).args, ['logout']);
  assert.deepEqual(accountCommand('claude', 'login', resolve).args, ['auth', 'login']);
  assert.deepEqual(accountCommand('claude', 'logout', resolve).args, ['auth', 'logout']);
  assert.deepEqual(accountCommand('opencode', 'login', resolve).args, ['auth', 'login']);
  assert.deepEqual(accountCommand('opencode', 'logout', resolve).args, ['auth', 'logout']);
  for (const [agent, action] of [['shell', 'login'], ['codex', 'exec'], ['opencode', 'logout; echo bad']]) assert.throws(() => accountCommand(agent, action, resolve), /Unsupported/);
});
test('account plans require fresh single-use confirmation, reject live chats and recheck executable; tests never run auth', async () => {
  let blocked = false; const launched = [], accounts = new Accounts({ resolve, status: async () => 'unknown', blocked: () => blocked, launch: async command => { launched.push(command); return { requested: true }; } });
  assert.equal((await accounts.inventory()).length, 3);
  let plan = accounts.plan('codex', 'logout'); assert.equal(launched.length, 0);
  blocked = true; await assert.rejects(accounts.confirm(plan.token), /Close/); assert.equal(launched.length, 0);
  assert.throws(() => accounts.plan('claude', 'login'), /Close/); blocked = false;
  plan = accounts.plan('opencode', 'logout'); accounts.plans.get(plan.token).expires = 0;
  await assert.rejects(accounts.confirm(plan.token), /expired/);
  plan = accounts.plan('claude', 'login'); await accounts.confirm(plan.token);
  assert.equal(launched.length, 1); assert.deepEqual(launched[0].args, ['auth', 'login']);
  await assert.rejects(accounts.confirm(plan.token), /expired/);
  plan = accounts.plan('codex', 'logout'); const original = resolve.codex; resolve.codex = () => ({ file: 'changed.exe', args: [] });
  try { await assert.rejects(accounts.confirm(plan.token), /CLI changed/); } finally { resolve.codex = original; }
  assert.equal(launched.length, 1);
});

test('status reads return fixed enums only, never native account details', async () => {
  assert.deepEqual(accountStatusCommand('codex', resolve).args, ['login', 'status']);
  assert.deepEqual(accountStatusCommand('claude', resolve).args, ['auth', 'status', '--json']);
  assert.deepEqual(accountStatusCommand('opencode', resolve).args, ['auth', 'list', '--pure']);
  assert.equal(parseAccountStatus('codex', { code: 0, stderr: 'private native details' }), 'logged-in');
  assert.equal(parseAccountStatus('codex', { code: 1, stderr: 'Not logged in' }), 'logged-out');
  assert.equal(parseAccountStatus('codex', { code: 1, stderr: 'Configuration error' }), 'unknown');
  assert.equal(parseAccountStatus('claude', { code: 0, stdout: '{"loggedIn":true,"email":"private"}' }), 'logged-in');
  assert.equal(parseAccountStatus('claude', { code: 1, stdout: '{"loggedIn":false}' }), 'logged-out');
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: 'Credentials\n● OpenAI oauth\n1 credential' }), 'logged-in');
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: 'Credentials\n0 credentials' }), 'logged-out');
  assert.equal(parseAccountStatus('opencode', { code: 1, stdout: 'failed' }), 'unknown');
  const accounts = new Accounts({ resolve, status: async () => 'logged-in' });
  const rows = await accounts.inventory(); assert.equal(rows.every(row => row.status === 'logged-in'), true);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agent', 'available', 'label', 'status']);
});
