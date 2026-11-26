import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { terminalCommand, childEnvironment } from '../agents.mjs';
import { Sessions } from '../sessions.mjs';
import { codexCommandFixture } from './cli-fixture.mjs';

test('standalone children do not inherit another Codex app package routing', () => {
  const base = { CODEX_WINDOWS_REGISTERED_CORE: '1', codex_windows_sandbox_package_family: 'synthetic-package', PATH: 'unchanged', USERPROFILE: 'unchanged' };
  const env = childEnvironment(null, base);
  assert.equal(env.CODEX_WINDOWS_REGISTERED_CORE, undefined);
  assert.equal(env.codex_windows_sandbox_package_family, undefined);
  assert.equal(env.PATH, base.PATH); assert.equal(env.USERPROFILE, base.USERPROFILE);
  assert.equal(base.CODEX_WINDOWS_REGISTERED_CORE, '1');
});

test('standalone shells exclude inherited Codex PSReadLine modules without weakening policy or removing personal modules', () => {
  const bundled = path.join(os.tmpdir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'Modules');
  const personal = path.join(os.tmpdir(), 'PersonalModules'), system = path.join(os.tmpdir(), 'SystemModules');
  const base = { PSModulePath: [personal, bundled, system].join(path.delimiter), PSExecutionPolicyPreference: 'AllSigned' };
  const env = childEnvironment(null, base);
  assert.equal(env.PSModulePath, [personal, system].join(path.delimiter));
  assert.equal(env.PSExecutionPolicyPreference, 'AllSigned');
  assert.ok(base.PSModulePath.includes(bundled));
  assert.equal(childEnvironment(null, { psModulePath: bundled }).psModulePath, undefined);
});

test('Codex new/resume/fork commands use native automatic review without bypass', async t => {
  await codexCommandFixture(t);
  for (const extra of [{}, { resumeId: 'fixture', cwd: os.tmpdir() }, { resumeId: 'fixture', fork: true, cwd: os.tmpdir() }]) {
    const { args } = terminalCommand('codex', { ...extra, bypass: true, codexPermissions: 'auto-review', bridge: { script: path.join(os.tmpdir(), 'bridge.mjs'), contentDirectories: [os.tmpdir()], codexWritableRoots: true } });
    assert.ok(args.includes('--approve-for-me'));
    assert.ok(!args.includes('approvals_reviewer="user"'));
    assert.ok(!args.includes('--sandbox'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.includes('--add-dir'));
  }
  assert.ok(terminalCommand('codex', { bypass: true }).args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const native = terminalCommand('codex', { codexPermissions: 'ask', bypass: true }).args;
  assert.equal(native[native.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(native[native.indexOf('--ask-for-approval') + 1], 'on-request');
  assert.ok(native.includes('approvals_reviewer="user"'));
  assert.ok(!native.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('additional Hub roots require positive native-profile preflight for new, resume and fork', async t => {
  await codexCommandFixture(t);
  for (const mode of ['ask', 'auto-review', 'bypass']) for (const supported of [undefined, false, true]) {
    for (const extra of [{}, { resumeId: 'fixture', cwd: os.tmpdir() }, { resumeId: 'fixture', fork: true, cwd: os.tmpdir() }]) {
      const { args } = terminalCommand('codex', { ...extra, codexPermissions: mode, bridge: { script: path.join(os.tmpdir(), 'bridge.mjs'), contentDirectories: [os.tmpdir()], codexWritableRoots: supported } });
      assert.equal(args.includes('--add-dir'), supported === true && mode !== 'bypass');
      assert.ok(args.includes('mcp_servers.mrmak_workspace.enabled=true'), 'Bridge configuration remains enabled');
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), mode === 'bypass');
    }
  }
});

test('permission restart preflights native continuity and a close during preparation wins', async t => {
  await codexCommandFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-permission-resume-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  t.after(async () => { clearInterval(sessions.timer); await sessions.saveChain; await rm(root, { recursive: true, force: true }); });
  const transcript = path.join(root, 'fixture.jsonl'); await writeFile(transcript, '{}\n');
  for (const hasConversation of [false, true]) {
    const chat = sessions.make({ id: `chat-${hasConversation}`, agent: 'codex', cwd: root, nativeId: hasConversation ? 'native-id' : null, hasConversation, open: true, codexPermissions: 'auto-review' });
    const handlers = [];
    const proc = { onExit: callback => { handlers.push(callback); return { dispose() {} }; } };
    chat.process = proc; chat.launchedCodexPermissions = 'bypass'; sessions.items.set(chat.id, chat);
    sessions.nativeBoundary = async () => hasConversation ? { file: transcript } : null;
    sessions.prepareLaunch = async () => null;
    let stopped = 0, resumed;
    sessions.requestStop = () => { stopped++; chat.process = null; handlers.forEach(callback => callback()); };
    sessions.resume = async (id, nativeId) => { resumed = { id, nativeId }; };
    await sessions.restartTools(chat, { process: proc, inputAt: undefined, permissions: true });
    assert.equal(stopped, 1); assert.deepEqual(resumed, { id: chat.id, nativeId: chat.nativeId });
    chat.process = proc; chat.open = true;
    sessions.prepareLaunch = async () => { chat.open = false; return null; };
    await assert.rejects(sessions.restartTools(chat, { process: proc, inputAt: undefined, permissions: true }), /changed/);
    assert.equal(stopped, 1);
    chat.process = null;
  }
});

test('permission changes restart the same idle chat automatically and defer drafts, turns and approvals', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-auto-permissions-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  t.after(async () => { clearInterval(sessions.timer); await sessions.saveChain; await rm(root, { recursive: true, force: true }); });
  const chat = sessions.make({ id: 'auto', agent: 'codex', nativeId: 'same-native-chat', bypass: true, open: true });
  chat.process = {}; chat.launchedCodexPermissions = 'bypass'; sessions.items.set(chat.id, chat);
  let empty = true, restarts = 0;
  sessions.permissionReady = async () => empty;
  sessions.restartTools = async (item, guard) => {
    assert.equal(item.nativeId, 'same-native-chat'); assert.equal(item.id, 'auto'); assert.equal(guard.permissions, true);
    restarts++; item.launchedCodexPermissions = item.codexPermissions;
  };
  await sessions.setCodexPermissions(chat.id, 'auto-review'); assert.equal(restarts, 1);
  empty = false; await sessions.setCodexPermissions(chat.id, 'ask'); assert.equal(restarts, 1);
  empty = true; chat.activity = 'working'; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 1);
  chat.activity = 'idle'; chat.attention = true; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 1);
  chat.attention = false; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 2);
  await sessions.setCodexPermissions(chat.id, 'ask'); assert.equal(restarts, 2);
  sessions.permissionReady = async () => { chat.lastInputAt = 'changed'; return true; };
  await sessions.setCodexPermissions(chat.id, 'bypass'); assert.equal(restarts, 2);
  sessions.permissionReady = async () => { chat.open = false; return true; };
  await sessions.applyCodexPermissions(chat); assert.equal(restarts, 2);
  chat.open = true; sessions.permissionReady = async () => true;
  sessions.restartTools = async () => { restarts++; throw new Error('Preflight failed'); };
  await assert.rejects(sessions.applyCodexPermissions(chat), /Preflight failed/);
  await sessions.applyCodexPermissions(chat); assert.equal(restarts, 3);
});
