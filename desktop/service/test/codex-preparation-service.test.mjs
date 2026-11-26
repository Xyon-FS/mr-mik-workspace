import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createService, mkdtemp } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';

test('Codex selection prepares read-only, creation waits for safe input, and reopening waits for native unload', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-prepare-service-')), repo = path.join(base, 'hub'), home = path.join(base, 'os-home'), native = path.join(home, '.codex');
  await mkdir(native, { recursive: true }); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(native, 'config.toml'), 'model="fixture-model"\n');
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const service = await createService({ repo, mcpOptions: { home, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: native, CODEX_SQLITE_HOME: native } } });
  t.after(() => service.close());
  const profile = await service.profiles.create('Fixture prepare');
  service.profiles.assertIdentity = async () => ({ identityState: 'verified' });
  service.sessions.verifyAccount = async session => { session.verifyStartupAccount = async () => {}; };
  service.sessions.verifyIdentity = async () => {};
  const wire = pooledCodexFixture(), launch = service.codexPreparation.launch;
  service.codexPreparation.launch = async context => ({ ...await launch(context), spawnChild: wire.spawnChild });
  let openingRuntime;
  service.sessions.createGraphicalRuntime = options => (openingRuntime = new CodexChat({ ...options, workerPool: service.sessions.codexWorkers, spawnChild: wire.spawnChild }));
  const request = async (route, body) => {
    const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, value.error); return value;
  };
  const file = path.join(service.profiles.root, 'profiles', profile.id, 'config.toml'), original = await readFile(file, 'utf8');
  await request('/codexpreparation', { agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, codexPermissions: 'ask' });
  for (let i = 0; i < 150 && service.codexPreparation.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.codexPreparation.status, 'ready'); assert.equal(wire.children.length, 1);
  assert.equal(wire.calls.filter(call => call.method === 'thread/start').length, 0);
  assert.equal(await readFile(file, 'utf8'), original);
  await writeFile(path.join(repo, '.mcp.json'), '{ malformed unrelated Claude config');
  await writeFile(path.join(repo, 'opencode.json'), '{ malformed unrelated OpenCode config');
  const child = wire.children[0];
  const readiness = ['windowsSandbox/readiness', 'collaborationMode/list'];
  for (const method of readiness) child.holdMethods.add(method);
  const creating = request('/sessions', { agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, codexPermissions: 'ask' });
  let created;
  try {
    for (const method of readiness) {
      for (let i = 0; i < 200 && !child.heldReplies.has(method); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(child.heldReplies.has(method), method);
      assert.ok(openingRuntime.threadId);
      assert.equal(openingRuntime.snapshot().connected, false);
      await assert.rejects(openingRuntime.submit('Blocked while starting'), /Finish the current request/);
      assert.throws(() => openingRuntime.advanced.enqueue('Blocked queue', 'readiness-queue-0001'), /Resolve the current connection/);
      assert.equal(wire.calls.some(call => call.method === 'turn/start'), false);
      child.releaseReplies(method);
    }
  } finally {
    for (const method of readiness) child.releaseReplies(method);
    created = await creating;
  }
  const runtime = service.sessions.get(created.id).graphical;
  assert.equal(runtime.snapshot().connected, true);
  assert.equal(runtime.advanced.modeIntent, 'default');
  assert.equal(runtime.advanced.queue.length, 0);
  await runtime.submit('Synthetic lifecycle request');
  const starts = wire.calls.filter(call => call.method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.threadId, runtime.threadId);
  await runtime.interrupt();
  assert.ok(service.toolRefresh.baselines.get(created.id), 'Codex graphical launch must establish a known baseline despite malformed unrelated provider files');
  assert.equal(wire.children.length, 1); assert.equal(runtime.transport.child, wire.children[0]);
  // Deliberately keep native unload pending. Reopening the same saved session
  // must not dispatch resume until its previous attachment releases ownership.
  const boundary = service.sessions.nativeBoundary;
  service.sessions.nativeBoundary = async () => null; // Synthetic native wire has no disk transcript.
  wire.children[0].deferUnload = runtime.threadId;
  const closing = service.sessions.remove(created.id);
  let reopened = false, reopening;
  try {
    for (let i = 0; i < 100 && !wire.calls.some(call => call.method === 'thread/unsubscribe'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(wire.calls.some(call => call.method === 'thread/unsubscribe'));
    reopening = service.sessions.resume(created.id, runtime.threadId).then(value => { reopened = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reopened, false); assert.equal(runtime.closed, false);
    assert.equal(wire.calls.some(call => call.method === 'thread/resume'), false);
  } finally {
    wire.children[0].deferUnload = null; await closing; await reopening;
    service.sessions.nativeBoundary = boundary;
  }
  assert.equal(service.sessions.get(created.id).graphical.threadId, runtime.threadId);
  assert.equal(service.sessions.get(created.id).graphical.transport, runtime.transport);
  await service.sessions.remove(created.id); assert.equal(runtime.transport.closed, false);
  const metadataFile = path.join(service.profiles.root, 'profiles', profile.id, 'profile-layout.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')); metadata.version = 2;
  await writeFile(metadataFile, JSON.stringify(metadata));
  await service.profiles.context(profile.id, repo);
  assert.equal(runtime.transport.closed, true, 'layout migration must drain invisible idle workers first');
  assert.equal(JSON.parse(await readFile(metadataFile, 'utf8')).version, 3);
  await writeFile(path.join(native, 'config.toml'), 'model="fixture-alternate"\n');
  assert.equal(await service.profiles.inspectContext(profile.id, repo), null);
  assert.equal(await readFile(file, 'utf8'), original, 'speculative inspection must not synchronize a changed native config');
  await request('/accounts/profiles', { action: 'remove', id: profile.id });
  assert.equal(runtime.transport.closed, true); assert.equal(service.sessions.codexWorkers.retained.size, 0);
});

test('an MCP edit between profile resolution and tool capture cannot start a stale native root', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-mcp-generation-')), repo = path.join(base, 'hub'), home = path.join(base, 'os-home'), native = path.join(home, '.codex');
  await mkdir(native, { recursive: true }); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(native, 'config.toml'), 'model="fixture-model"\n');
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const service = await createService({ repo, mcpOptions: { home, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: native, CODEX_SQLITE_HOME: native } } });
  t.after(() => service.close()); const profile = await service.profiles.create('Synthetic generation');
  service.profiles.assertIdentity = async () => ({ identityState: 'verified', identityEmail: 'synthetic@example.invalid' });
  const wire = pooledCodexFixture({ nativeAccount: { type: 'chatgpt', email: 'synthetic@example.invalid' }, nativeConfig: options => ({ cli_auth_credentials_store: 'file', sqlite_home: options.env.CODEX_SQLITE_HOME }) });
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, workerPool: service.sessions.codexWorkers, spawnChild: wire.spawnChild });
  const capture = service.sessions.captureTools; let baseline;
  service.sessions.captureTools = async session => {
    await writeFile(path.join(native, 'config.toml'), 'model="fixture-model"\n[mcp_servers.new_review]\nurl="http://127.0.0.1:1/mcp"\n');
    return baseline = await capture(session);
  };
  await assert.rejects(service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, codexPermissions: 'ask' }), /configuration changed/);
  assert.equal(baseline['codex:new_review'].enabled, true);
  assert.equal(wire.calls.some(call => call.method === 'thread/start'), false);
  service.sessions.captureTools = capture;
  const retried = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, codexPermissions: 'ask' });
  assert.ok(service.sessions.get(retried.id).graphical.snapshot().connected);
  assert.match(await readFile(path.join(service.profiles.root, 'profiles', profile.id, 'config.toml'), 'utf8'), /mcp_servers\.new_review/);
});
