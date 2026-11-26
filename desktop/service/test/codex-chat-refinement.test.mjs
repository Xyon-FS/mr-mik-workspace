import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-refinement-'));
  const transport = graphicalFixture(settings);
  const options = { session: { cwd: root, codexPermissions: 'ask', effort: 'medium', ...settings.session }, env: { ...process.env, CODEX_HOME: path.join(root, 'native-home') }, sandboxStateDir: path.join(root, 'state/sandbox'), spawnChild: transport.spawnChild };
  const runtime = new CodexChat(options); t.after(() => runtime.close()); await runtime.start();
  return { root, runtime, transport, options };
}

test('sandbox setup is explicit, serialized, handles refusal and retains only local setup mode', async t => {
  const { root, runtime, transport, options } = await fixture(t, { sandboxStatus: 'notConfigured' });
  assert.equal(transport.calls.some(call => call.method === 'windowsSandbox/setupStart'), false);
  runtime.draft = 'Keep my draft'; await assert.rejects(runtime.submit(), /sandbox setup/);
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
  await runtime.setupSandbox();
  assert.equal(runtime.draft, 'Keep my draft');
  const other = new CodexChat(options); t.after(() => other.close()); await other.start();
  await assert.rejects(other.setupSandbox(), /already in progress/);
  transport.children[0].notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: false });
  await delay(10); assert.match(runtime.sandbox.error, /did not complete/);
  await runtime.setupSandbox();
  transport.children[0].notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true });
  for (let i = 0; i < 50 && runtime.sandbox.settingUp; i++) await delay(10);
  assert.equal(runtime.sandbox.restartRequired, true);
  await runtime.close();
  const reopened = new CodexChat(options); t.after(() => reopened.close()); await reopened.start();
  assert.ok(transport.children.at(-1).args.includes('windows.sandbox="elevated"'));
  assert.equal(await lstat(path.join(root, 'native-home/config.toml')).catch(() => null), null);
});

test('legacy native policy is inherited and full access retains user review without sandbox setup', async t => {
  const native = await fixture(t, { session: { codexPermissions: 'native' } });
  const request = native.transport.calls.find(call => call.method === 'thread/start').params;
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox']) assert.equal(key in request, false);
  assert.equal(native.transport.children[0].args.some(arg => /^(sandbox_mode|approval_policy|approvals_reviewer)=/.test(arg)), false);
  const full = await fixture(t, { session: { codexPermissions: 'full-access' }, sandboxStatus: 'notConfigured' });
  const fullRequest = full.transport.calls.find(call => call.method === 'thread/start').params;
  assert.equal(fullRequest.sandbox, 'danger-full-access');
  assert.equal(fullRequest.approvalPolicy, 'on-request');
  assert.equal(fullRequest.approvalsReviewer, 'user');
  assert.equal(full.runtime.snapshot().requiresSandbox, false);
  await full.runtime.submit('Synthetic request, no model call.');
  assert.equal(full.transport.calls.some(call => call.method === 'windowsSandbox/setupStart'), false);
});

test('different auth homes serialize sandbox setup and share mode preferences through the canonical home', async t => {
  const first = await fixture(t, { sandboxStatus: 'notConfigured' });
  const common = path.join(first.root, 'common');
  first.runtime.sandboxEnv = { ...first.options.env, CODEX_HOME: common };
  const second = new CodexChat({ ...first.options, sharedHome: common, env: { ...first.options.env, CODEX_HOME: path.join(first.root, 'other-auth') } });
  t.after(() => second.close()); await second.start();
  await first.runtime.setupSandbox();
  await assert.rejects(second.setupSandbox(), /already in progress/);
  for (let i = 0; i < 50 && !first.transport.calls.some(call => call.method === 'windowsSandbox/setupStart'); i++) await delay(10);
  const setup = first.transport.children.at(-1);
  assert.equal(setup.options.env.CODEX_HOME, common);
  assert.equal(setup.options.windowsHide, true);
  const startCount = first.transport.calls.filter(call => call.method === 'thread/start').length;
  assert.equal(startCount, 2, 'Setup does not create a third conversation');
  setup.notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true });
  for (let i = 0; i < 50 && first.runtime.sandbox.settingUp; i++) await delay(10);
  assert.equal(setup.closed, true, 'Only the setup worker is closed');
  assert.equal(first.transport.children[0].closed, undefined);
  const reopened = new CodexChat({ ...first.options, sharedHome: common }); t.after(() => reopened.close()); await reopened.start();
  assert.ok(first.transport.children.at(-1).args.includes('windows.sandbox="elevated"'));
});

test('shared setup failure releases the shared reservation and preserves the draft', async t => {
  const first = await fixture(t, { sandboxStatus: 'updateRequired' });
  first.runtime.sandboxEnv = { ...first.options.env, CODEX_HOME: path.join(first.root, 'common') };
  first.runtime.draft = 'Keep this draft';
  await first.runtime.setupSandbox();
  for (let i = 0; i < 50 && !first.transport.calls.some(call => call.method === 'windowsSandbox/setupStart'); i++) await delay(10);
  first.transport.children.at(-1).notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: false, error: 'cancelled' });
  await first.runtime.sandboxSetup;
  assert.match(first.runtime.sandbox.error, /cancelled/);
  assert.equal(first.runtime.draft, 'Keep this draft');
  assert.equal(first.runtime.sandbox.settingUp, false);
  assert.equal(first.transport.children.at(-1).closed, true);
});

test('a later draft revision survives acknowledgement even when text is identical', async t => {
  const { runtime } = await fixture(t);
  const rpc = runtime.rpc.bind(runtime); let acknowledge;
  runtime.rpc = (method, params) => method === 'turn/start' ? new Promise(resolve => { acknowledge = resolve; }) : rpc(method, params);
  runtime.draft = 'Same text'; const sent = runtime.submit();
  runtime.draftRevision++; runtime.draft = 'Same text';
  acknowledge({ turn: { id: 'synthetic', status: 'completed' } }); await sent;
  assert.equal(runtime.draft, 'Same text');
});
