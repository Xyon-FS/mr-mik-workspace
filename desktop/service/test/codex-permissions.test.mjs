import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexPermissionMode } from '../codex-permissions.mjs';
import { terminalCommand } from '../agents.mjs';
import { Sessions } from '../sessions.mjs';
import { codexCommandFixture } from './cli-fixture.mjs';

test('Codex modes preserve legacy choices and reject invalid permission values', () => {
  assert.equal(codexPermissionMode(undefined, true), 'bypass');
  assert.equal(codexPermissionMode(undefined, false), 'native');
  assert.equal(codexPermissionMode('full-access', true), 'full-access');
  assert.throws(() => codexPermissionMode('automatic'), /Invalid/);
});

test('Codex new/resume/fork commands explicitly request user approvals without bypass', async t => {
  await codexCommandFixture(t);
  for (const extra of [{}, { resumeId: 'fixture', cwd: os.tmpdir() }, { resumeId: 'fixture', fork: true, cwd: os.tmpdir() }]) {
    const { args } = terminalCommand('codex', { ...extra, bypass: true, codexPermissions: 'full-access', bridge: { script: path.join(os.tmpdir(), 'bridge.mjs'), contentDirectories: [os.tmpdir()], codexWritableRoots: true } });
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
    assert.ok(args.includes('approvals_reviewer="user"'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--add-dir'));
  }
  assert.ok(terminalCommand('codex', { bypass: true }).args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const native = terminalCommand('codex', { codexPermissions: 'native', bypass: true }).args;
  assert.ok(!native.includes('--sandbox') && !native.includes('--ask-for-approval') && !native.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('without a readiness adapter permission changes remain saved and never touch the running CLI', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-permissions-test-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  t.after(async () => { clearInterval(sessions.timer); await sessions.saveChain; await rm(root, { recursive: true, force: true }); });
  const item = sessions.make({ id: 'test', agent: 'codex', nativeId: 'native-chat', bypass: true });
  let touched = false;
  item.process = { kill() { touched = true; } };
  item.launchedCodexPermissions = 'bypass';
  sessions.items.set(item.id, item);
  const changed = await sessions.setCodexPermissions(item.id, 'full-access');
  assert.equal(changed.nativeId, 'native-chat');
  assert.equal(changed.bypass, false);
  assert.equal(changed.codexPermissionsPending, true);
  assert.equal(touched, false);
  await assert.rejects(sessions.restartTools(item, { process: item.process, inputAt: null }), /automatic restart/);
  const saved = JSON.parse(await readFile(path.join(root, 'state', 'sessions.json'), 'utf8'))[0];
  assert.equal(saved.codexPermissions, 'full-access');
  assert.ok(!('codexPermissionsPending' in saved));
  assert.equal(sessions.make(saved).codexPermissions, 'full-access');
  assert.equal((await sessions.setCodexPermissions(item.id, 'bypass')).codexPermissionsPending, false);
  await assert.rejects(sessions.setCodexPermissions(item.id, 'unknown'), /Invalid/);
  sessions.items.set('other', sessions.make({ id: 'other', agent: 'claude' }));
  await assert.rejects(sessions.setCodexPermissions('other', 'full-access'), /only available for Codex/);
});

test('permission restart preflights native continuity and a close during preparation wins', async t => {
  await codexCommandFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-permission-resume-'));
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  t.after(async () => { clearInterval(sessions.timer); await sessions.saveChain; await rm(root, { recursive: true, force: true }); });
  const transcript = path.join(root, 'fixture.jsonl'); await writeFile(transcript, '{}\n');
  for (const hasConversation of [false, true]) {
    const chat = sessions.make({ id: `chat-${hasConversation}`, agent: 'codex', cwd: root, nativeId: hasConversation ? 'native-id' : null, hasConversation, open: true, codexPermissions: 'full-access' });
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
  await sessions.setCodexPermissions(chat.id, 'full-access'); assert.equal(restarts, 1);
  empty = false; await sessions.setCodexPermissions(chat.id, 'native'); assert.equal(restarts, 1);
  empty = true; chat.activity = 'working'; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 1);
  chat.activity = 'idle'; chat.attention = true; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 1);
  chat.attention = false; await sessions.applyCodexPermissions(chat); assert.equal(restarts, 2);
  await sessions.setCodexPermissions(chat.id, 'native'); assert.equal(restarts, 2);
  sessions.permissionReady = async () => { chat.lastInputAt = 'changed'; return true; };
  await sessions.setCodexPermissions(chat.id, 'bypass'); assert.equal(restarts, 2);
  sessions.permissionReady = async () => { chat.open = false; return true; };
  await sessions.applyCodexPermissions(chat); assert.equal(restarts, 2);
  chat.open = true; sessions.permissionReady = async () => true;
  sessions.restartTools = async () => { restarts++; throw new Error('Preflight failed'); };
  await assert.rejects(sessions.applyCodexPermissions(chat), /Preflight failed/);
  await sessions.applyCodexPermissions(chat); assert.equal(restarts, 3);
});
