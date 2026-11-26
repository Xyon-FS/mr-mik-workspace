import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-live-permissions-')), hub = path.join(root, 'hub'), sqliteHome = path.join(root, 'sqlite');
  await mkdir(hub); await mkdir(sqliteHome);
  const transport = graphicalFixture({ completeBeforeResponse: true, ...options });
  const sessions = await new Sessions(hub, path.join(root, 'state')).init();
  t.after(async () => { await sessions.close(); for (const child of transport.children) child.kill(); });
  sessions.accountContext = async session => ({ label: 'Fixture', conversationStoreId: 'fixture', profileId: session.accountProfileId, sqliteHome, env: process.env });
  sessions.permissionReady = session => session.graphical.ready();
  sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const chat = await sessions.create({ agent: 'codex', cwd: hub, chatInterface: 'chat', codexPermissions: 'ask', accountProfileId: 'fixture', effort: 'medium' });
  const session = sessions.get(chat.id), runtime = session.graphical;
  // Native-shaped project sandbox, including non-default roots/network flags.
  runtime.permissions.workspacePolicy = { type: 'workspaceWrite', writableRoots: [path.join(root, 'shared')], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false };
  return { sessions, session, runtime, transport };
}

test('unread completion does not block live graphical permissions or alter Plan/model/reasoning', async t => {
  const { sessions, session: s, runtime: r, transport } = await fixture(t);
  await r.advanced.selectMode('plan'); await r.submit('Synthetic request');
  assert.equal(s.attention, true); assert.equal(s.unread, true);
  await sessions.setCodexPermissions(s.id, 'bypass');
  assert.equal(s.unread, true); assert.equal(r.effective.sandbox, 'dangerFullAccess'); assert.equal(r.sandboxRequired(), false);
  assert.equal(r.advanced.modeIntent, 'plan'); assert.equal(s.effort, 'medium'); assert.equal(r.effective.model, 'fixture-model');
  await sessions.setCodexPermissions(s.id, 'ask'); assert.equal(r.effective.sandbox, 'workspaceWrite');
  assert.deepEqual(r.permissions.policy.sandboxPolicy.writableRoots, r.permissions.workspacePolicy.writableRoots);
  assert.equal(transport.calls.some(call => call.method === 'thread/resume'), false);
});

test('active work, pending questions and queued requests reject changes without recording a false pending selection', async t => {
  const { sessions, session: s, runtime: r } = await fixture(t);
  r.message({ method: 'turn/started', params: { threadId: r.threadId, turn: { id: 'busy', status: 'inProgress' } } });
  await assert.rejects(sessions.setCodexPermissions(s.id, 'bypass'), /Finish the current request/);
  assert.equal(s.codexPermissions, 'ask'); assert.equal(r.permissions.uncertain, false);
  r.message({ method: 'turn/completed', params: { threadId: r.threadId, turn: { id: 'busy', status: 'completed' } } });
  r.requests.set('question', {}); await assert.rejects(sessions.setCodexPermissions(s.id, 'bypass'), /Finish/); r.requests.clear();
  r.advanced.pause(true); r.advanced.enqueue('Later', 'request-permissions-0001');
  await assert.rejects(sessions.setCodexPermissions(s.id, 'bypass'), /clear the queue/); assert.equal(s.codexPermissions, 'ask');
});

test('missing native confirmation blocks execution until an explicit checked retry, without restarting', async t => {
  const { runtime: r, transport } = await fixture(t);
  const rpc = r.rpc.bind(r); r.rpc = async () => ({});
  await assert.rejects(r.permissions.apply('bypass', 20), /not confirmed/);
  assert.equal(r.permissions.uncertain, true); assert.equal(r.idle(), false); assert.equal(r.permissions.busy, false);
  r.rpc = rpc; await r.permissions.apply('ask');
  assert.equal(r.permissions.uncertain, false); assert.equal(r.idle(), true); assert.equal(transport.children.length, 1);
});

test('native permission choice uses a closed temporary resolver and retains the managed conversation', async t => {
  const { sessions, session: s, runtime: r, transport } = await fixture(t);
  await sessions.setCodexPermissions(s.id, 'native');
  assert.equal(s.graphical, r); assert.equal(s.codexPermissions, 'native'); assert.equal(transport.children.length, 2);
  assert.equal(transport.children[0].closed, undefined); assert.equal(transport.children[1].closed, true);
  assert.equal(transport.children[1].args.some(arg => /^(approval_policy|approvals_reviewer|sandbox_mode)=/.test(arg)), false);
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});
