import test from 'node:test';
import assert from 'node:assert/strict';
import { Accounts, accountCommand, accountStatusCommand, parseAccountStatus, runHiddenAccountCommand } from '../accounts.mjs';
import { spawn } from 'node:child_process';

const resolve = Object.fromEntries(['codex', 'claude', 'opencode'].map(agent => [agent, () => ({ file: `C:/Fixture/${agent}.exe`, args: [] })]));

test('hidden account command observes completion with ignored streams, bounded timeout and cancellation', async () => {
  let options, started;
  const command = { file: process.execPath, args: ['-e', 'console.log("synthetic-auth-output"); console.error("synthetic-private-details")'] };
  const result = await runHiddenAccountCommand(command, process.env, { onStart: pid => { started = pid; }, spawnProcess: (file, args, value) => { options = value; return spawn(file, args, value); } });
  assert.deepEqual(result, { requested: true, completed: true });
  assert.ok(Number.isInteger(started)); assert.equal(options.windowsHide, true); assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, false);
  await assert.rejects(runHiddenAccountCommand({ file: process.execPath, args: ['-e', 'process.exit(1)'] }), /did not complete/);
  const long = { file: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] };
  await assert.rejects(runHiddenAccountCommand(long, process.env, { timeoutMs: 10 }), /timed out/);
  const controller = new AbortController();
  await assert.rejects(runHiddenAccountCommand(long, process.env, { signal: controller.signal, onStart: () => controller.abort() }), /cancelled/);
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

test('display reads coalesce only in flight and invalidated stale reads cannot evict a newer request', async () => {
  const accounts = new Accounts({resolve}), gates = [];
  accounts.readProfileInventory = () => new Promise(done => gates.push(done));
  try {
    const old = accounts.profileInventory(); assert.equal(accounts.profileInventory(), old); assert.equal(gates.length, 1);
    accounts.invalidateDisplay('codex'); const fresh = accounts.profileInventory(); assert.notEqual(fresh, old);
    gates[0]([{label:'old'}]); await old; assert.equal(accounts.profileInventory(), fresh);
    gates[1]([{label:'new'}]); assert.deepEqual(await fresh,[{label:'new'}]);
    const last=accounts.profileInventory(); assert.equal(gates.length,3);
    let closed=false;const closing=accounts.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
    gates[2]([]);await last;await closing;await assert.rejects(accounts.profileInventory(),/shutting down/);
  } finally { for(const done of gates)done([]);await accounts.close(); }
});

test('large registries bound native status processes and shutdown skips queued accounts', async () => {
  const rows=Array.from({length:20},(_,n)=>({id:String(n),label:'Fixture '+n,system:false}));
  const gates=[];let started=0;
  const accounts=new Accounts({resolve,profiles:{list:async()=>rows,accountAction:async()=>null,identityStates:async()=>[],statusContext:async()=>({env:{}})},status:()=>{started++;return new Promise(done=>gates.push(done));}});
  try {
    const reading=accounts.profileInventory();
    for(let n=0;n<30&&started<4;n++)await new Promise(done=>setTimeout(done,1));
    assert.equal(started,4);
    const closing=accounts.close();for(const done of gates)done('logged-out');
    const values=await reading;await closing;assert.equal(started,4);assert.deepEqual(values.map(row=>row.id),rows.map(row=>row.id));
    assert.equal(values.filter(row=>row.status==='logged-out').length,4);assert.equal(values.filter(row=>row.available===false).length,16);
  } finally {for(const done of gates)done('logged-out');await accounts.close();}
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
