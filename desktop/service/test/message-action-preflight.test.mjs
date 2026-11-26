import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

test('a definite missing-attachment preflight failure can be retried with its same delivery identity after repair', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-action-preflight-'));
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(base, 'native');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(native, 'config.toml'), '# Synthetic');
  const service = await createService({ repo, mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  try {
    const profile = await service.profiles.create('Synthetic preflight');
    service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
    const turns = new Map(), transport = graphicalFixture({ turnHistory: turns, completeBeforeResponse: true });
    service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
    const created = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', name: 'Synthetic original', accountProfileId: profile.id, cwd: repo, codexPermissions: 'bypass' });
    const source = service.sessions.get(created.id), runtime = source.graphical, file = path.join(repo, 'temporarily-missing.png');
    const turn = { id: 'turn-1', status: 'completed', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Synthetic prompt' }, { type: 'localImage', path: file }] }, { id: 'answer-1', type: 'agentMessage', text: 'Synthetic response', status: 'completed' }] };
    turns.set(source.nativeId, [turn]); runtime.rememberTurn(turn);
    for (const item of turn.items) runtime.upsert(item, { turnId: turn.id });
    service.sessions.changed(source);
    const request = { kind: 'retry', itemId: 'answer-1', requestId: randomUUID() };
    const send = async () => {
      const response = await fetch(`${service.origin}/api/sessions/${source.id}/messageaction`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    };
    const before = await send(); assert.equal(before.status, 400); assert.match(before.body.error, /attachment/i);
    assert.equal(service.sessions.items.size, 1); assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
    await writeFile(file, 'Synthetic image');
    const repaired = await send();
    assert.equal(repaired.status, 201, JSON.stringify(repaired.body));
    assert.equal(service.sessions.items.size, 2); assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
    const repeated = await send(); assert.equal(repeated.status, 201); assert.equal(repeated.body.session.id, repaired.body.session.id);
    assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { await service.close(); }
});
