import test from 'node:test';
import { codexCommandFixture } from './cli-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

async function fixture(t) {
  await codexCommandFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-empty-codex-')), sqliteHome = path.join(root, 'sqlite');
  await mkdir(sqliteHome);
  const wire = graphicalFixture({ completeBeforeResponse: true }), calls = [];
  const sessions = await new Sessions(root, path.join(root, 'state')).init();
  t.after(() => sessions.close());
  sessions.accountContext = async session => ({ profileId: session.accountProfileId, label: 'Synthetic', conversationStoreId: 'common', sqliteHome, env: { ...process.env, CODEX_HOME: root } });
  sessions.permissionReady = session => session.graphical.ready();
  sessions.createGraphicalRuntime = options => {
    const runtime = new CodexChat({ ...options, spawnChild: wire.spawnChild });
    const rpc = runtime.rpc.bind(runtime);
    runtime.rpc = async (method, ...args) => {
      calls.push(method);
      if (method === 'thread/resume' && !options.session.hasConversation) throw Object.assign(new Error('no rollout found for thread id'), { nativeRejected: true });
      return rpc(method, ...args);
    };
    return runtime;
  };
  const created = await sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'first', cwd: root });
  return { root, sessions, session: sessions.get(created.id), wire, calls };
}

test('Codex account switches replace empty roots and preserve the used root on reopen', async t => {
  const { sessions, session, calls } = await fixture(t), originalId = session.nativeId, tab = session.id;
  session.graphical.advanced.modeIntent = 'plan';
  await sessions.setAccountProfile(tab, 'second');
  assert.equal(session.id, tab); assert.equal(session.accountProfileId, 'second');
  assert.notEqual(session.nativeId, originalId); assert.equal(session.graphical.snapshot().connected, true);
  assert.equal(session.graphical.advanced.modeIntent, 'plan'); assert.equal(session.hasConversation, false);
  await sessions.setAccountProfile(tab, 'first');
  assert.equal(session.accountProfileId, 'first'); assert.equal(session.graphical.snapshot().connected, true);
  assert.equal(calls.filter(method => method === 'thread/start').length, 3);
  assert.equal(calls.includes('thread/resume'), false); assert.equal(calls.includes('turn/start'), false);

  await session.graphical.submit('Synthetic local protocol only');
  assert.equal(session.hasConversation, true);
  const nativeId = session.nativeId;
  await sessions.setAccountProfile(session.id, 'second');
  assert.equal(session.nativeId, nativeId);
  await sessions.remove(session.id); await sessions.resume(session.id);
  assert.equal(session.nativeId, nativeId); assert.equal(session.graphical.snapshot().connected, true);
  assert.equal(calls.filter(method => method === 'thread/start').length, 3);
  assert.equal(calls.filter(method => method === 'thread/resume').length, 2);
  assert.equal(calls.filter(method => method === 'turn/start').length, 1);
});

test('empty reopen preserves the local draft and cannot hide explicit native recovery failures', async t => {
  const { sessions, session, calls } = await fixture(t), originalId = session.nativeId;
  session.graphical.draft = 'Keep this unsent draft';
  await sessions.remove(session.id); await sessions.resume(session.id);
  assert.notEqual(session.nativeId, originalId); assert.equal(session.graphical.draft, 'Keep this unsent draft');
  assert.equal(calls.includes('thread/resume'), false);
  await sessions.remove(session.id);
  const starts = calls.filter(method => method === 'thread/start').length;
  await assert.rejects(sessions.resume(session.id, originalId), /no rollout found/);
  assert.equal(calls.filter(method => method === 'thread/start').length, starts);
});

test('uncertain or submitted Codex work never falls back to an empty replacement root', async t => {
  const { sessions, session, calls } = await fixture(t);
  session.graphical.uncertain = true;
  await sessions.remove(session.id);
  await assert.rejects(sessions.resume(session.id), /no rollout found/);
  assert.equal(calls.filter(method => method === 'thread/start').length, 1);
  session.graphical.uncertain = false; session.lastInputAt = new Date().toISOString();
  await assert.rejects(sessions.resume(session.id), /no rollout found/);
  assert.equal(calls.filter(method => method === 'thread/start').length, 1);
});

