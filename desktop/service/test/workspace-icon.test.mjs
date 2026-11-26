import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { validateWorkspaceIcon } from '../workspace-icon.mjs';
import { iconPng, iconDataUrl } from './workspace-icon-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';

test('workspace icons verify actual alpha pixels, visible content, bounds, all PNG filters and data types', () => {
  for (let filter = 0; filter <= 4; filter++) assert.equal(validateWorkspaceIcon(iconDataUrl({ filter })).dataUrl, iconDataUrl({ filter }));
  assert.equal(validateWorkspaceIcon(null), null);
  for (const value of [undefined, '', 'data:image/svg+xml;base64,PHN2Zy8+', iconDataUrl({ opaque: true }), iconDataUrl({ empty: true }), 'data:image/png;base64,' + 'A'.repeat(96000)]) assert.throws(() => validateWorkspaceIcon(value));
  const corrupt = iconPng(); corrupt.writeUInt32BE(500, 16); assert.throws(() => validateWorkspaceIcon(`data:image/png;base64,${corrupt.toString('base64')}`));
});

test('icons belong to workspace metadata, ignore linked folders, update immediately and retain portable metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-managed-icon-')), repo = path.join(root, 'hub'), linked = path.join(root, 'linked');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(linked); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(linked, 'icon.png'), iconPng());
  const service = await createService({ repo, mcpOptions: { home: path.join(root, 'home'), env: {} }, profileOptions: { root: path.join(root, 'accounts') } });
  try {
    const project = await service.projects.save({ name: 'Workspace', repositoryPath: linked }), headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const call = (id, body) => fetch(`${service.origin}/api/projects/${id}/icon`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(`${service.origin}/api/projects/${project.id}/icon`)).status, 401);
    assert.deepEqual(await (await call(project.id)).json(), { dataUrl: null });
    assert.equal((await call(project.id, { dataUrl: iconDataUrl({ opaque: true }) })).status, 400);
    assert.equal((await call(project.id, { dataUrl: iconDataUrl() })).status, 200);
    const updated = await service.projects.get(project.id); assert.ok(updated.iconRevision); assert.equal(updated.iconDataUrl, undefined, 'Bootstrap does not contain bitmap payloads');
    await service.projects.save({ id: project.id, name: 'Renamed workspace' });
    const saved = await fetch(`${service.origin}/api/projects/${project.id}/icon?path=outside`, { headers });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).dataUrl, iconDataUrl());
    assert.notEqual((await call('missing')).status, 200);
    assert.equal((await service.projects.metadata()).projects[0].iconDataUrl, iconDataUrl());
    const snapshot = new WorkspaceSnapshot(repo, path.join(repo, '.mrmak'), service.projects);
    assert.equal((await snapshot.contents(project.id)).manifest.project.iconDataUrl, iconDataUrl());
    assert.deepEqual(await readFile(path.join(linked, 'icon.png')), iconPng());
    assert.equal((await call('missing', { dataUrl: iconDataUrl() })).status, 400);
    await call(project.id, { dataUrl: null }); assert.deepEqual(await (await call(project.id)).json(), { dataUrl: null });
  } finally { await service.close(); }
});

test('icon generation reads native account model catalogue without prompts, submits only the chosen model and retains normal chat ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-icon-generation-')), repo = path.join(root, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const codexHome = path.join(root, 'codex');
  await mkdir(codexHome);
  const service = await createService({ repo, mcpOptions: { home: path.join(root, 'home'), env: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome } }, profileOptions: { root: path.join(root, 'accounts') } });
  const fixture = graphicalFixture();
  try {
    service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
    service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: fixture.spawnChild });
    const profile = await service.profiles.create('Icon account'), project = await service.projects.save({ name: 'Game tools' });
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const call = async body => { const response = await fetch(`${service.origin}/api/projects/${project.id}/icon-generation`, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
    const prepared = await call({ action: 'prepare', agent: 'codex', accountProfileId: profile.id }); assert.equal(prepared.status, 201);
    assert.equal(prepared.data.models.length, 2); assert.equal(fixture.calls.filter(call => call.method === 'turn/start').length, 0);
    const session = service.sessions.get(prepared.data.sessionId); assert.equal(session.accountProfileId, profile.id); assert.equal(session.repositoryId, null); assert.equal(session.bypass, false);
    const input = { sessionId: prepared.data.sessionId, runtimeId: prepared.data.runtimeId, description: 'A tool case' };
    assert.notEqual((await call({ ...input, action: 'generate', model: 'invented' })).status, 200);
    assert.equal((await call({ ...input, action: 'generate', model: 'fixture-alternate' })).status, 200);
    const sent = fixture.calls.filter(call => call.method === 'turn/start'); assert.equal(sent.length, 1); assert.equal(sent[0].params.model, 'fixture-alternate'); assert.match(sent[0].params.input[0].text, /REAL alpha transparency/);
    assert.equal((await call({ ...input, action: 'status' })).status, 200);
    assert.notEqual((await call({ ...input, runtimeId: 'stale', action: 'status' })).status, 200);
    const wires = [];
    try {
      service.sessions.createGraphicalRuntime = options => { const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
      const claude = await call({ action: 'prepare', agent: 'claude', accountProfileId: 'system' }); assert.equal(claude.status, 201);
      assert.ok(claude.data.models.some(model => model.value === 'fixture-sonnet'));
      assert.equal(wires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 0);
      const result = await call({ action: 'generate', sessionId: claude.data.sessionId, runtimeId: claude.data.runtimeId, model: 'fixture-sonnet', description: 'A small game controller' }); assert.equal(result.status, 200);
      assert.equal(service.sessions.get(claude.data.sessionId).graphicalModel, 'fixture-sonnet');
      assert.equal(wires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 1);
    } finally { for (const wire of wires) wire.close(); }
  } finally { await service.close(); }
});
