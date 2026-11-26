import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';

test('malformed JSON shapes are rejected before mutation and the service remains usable after repeated invalid requests', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-adversarial-api-')), repo = path.join(base, 'hub'); await mkdir(repo);
  const service = await createService({ repo, uiDir: repo, restoreSessions: false, mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'accounts') } });
  try {
    const before = await readFile(service.projects.workspacePath, 'utf8').catch(() => null);
    let requests = 0;
    for (const route of ['/settings', '/projects', '/cards/page', '/accounts/confirm', '/workspace/import']) {
      for (const raw of ['null', '[]', '[{"name":"synthetic"}]', 'true', '42', '"not-an-object"', '{broken']) {
        const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: raw });
        assert.equal(response.status, 400, `${route}: ${raw}`);
        assert.match((await response.json()).error, /JSON/); requests++;
      }
    }
    assert.equal(requests, 35);
    assert.equal((await fetch(service.origin + '/health')).status, 200);
    assert.equal(await readFile(service.projects.workspacePath, 'utf8').catch(() => null), before);
    assert.equal(service.sessions.list().length, 0); assert.equal(service.coordinator.operationPromises.size, 0);
  } finally { await service.close(); }
});


test('rejected mixed settings patches leave memory and persisted settings unchanged', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-settings-atomic-')), repo = path.join(base, 'hub'); await mkdir(repo);
  const service = await createService({ repo, uiDir: repo, restoreSessions: false, mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'accounts') } });
  try {
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const settings = async () => (await (await fetch(service.origin + '/api/bootstrap', { headers })).json()).settings;
    const original = await settings();
    const settingsFile = path.join(repo, '.mrmak', 'settings.json'), diskBefore = await readFile(settingsFile, 'utf8').catch(() => null);
    const project = await service.projects.save({ name: 'Synthetic target' });
    for (const patch of [
      { defaultBypass: !original.defaultBypass, terminalFontSize: 24, completionNotifications: 'invalid' },
      { selectedProjectId: project.id, defaultCodexPermissions: 'invalid-mode' },
      { selectedProjectId: project.id, defaultClaudePermissions: 'invalid-mode' },
    ]) {
      const response = await fetch(service.origin + '/api/settings', { method: 'POST', headers, body: JSON.stringify(patch) });
      assert.equal(response.ok, false);
      assert.deepEqual(await settings(), original, 'Rejected settings must not partially mutate memory');
      assert.equal(await readFile(settingsFile, 'utf8').catch(() => null), diskBefore, 'Rejected settings must not change disk');
    }
    const response = await fetch(service.origin + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ terminalFontSize: 16 }) });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.defaultBypass, original.defaultBypass); assert.equal(saved.selectedProjectId, original.selectedProjectId);
    assert.equal(saved.terminalFontSize, 16);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), saved);
  } finally { await service.close(); }
});


test('quick card updates respect the same registration lock as imports and card creation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-card-lock-')), repo = path.join(base, 'hub'); await mkdir(repo);
  const service = await createService({ repo, uiDir: repo, restoreSessions: false, mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'accounts') } });
  let release, update, blocked;
  try {
    await mkdir(path.join(repo, 'workspace')); await writeFile(service.projects.workspacePath, '{"entities":[]}');
    const card = await service.projects.createCard({ title: 'Concurrent card' });
    let entered; const active = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    blocked = service.projects.serialize(async () => { entered(); await gate; }); await active;
    update = service.coordinator.execute('update_workspace', { entityId: card.id, pinned: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    const registry = JSON.parse(await readFile(service.projects.workspacePath, 'utf8'));
    assert.equal(!!registry.entities.find(item => item.id === card.id).pinned, false, 'Quick update must wait for an in-progress registration transaction');
    release(); await blocked; await update;
    assert.equal(JSON.parse(await readFile(service.projects.workspacePath, 'utf8')).entities.find(item => item.id === card.id).pinned, true);
  } finally { release?.(); await Promise.allSettled([blocked, update]); await service.close(); }
});


test('parallel card and page creation preserves every successful write and recovers after a rejected edit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-parallel-cards-')), repo = path.join(base, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, restoreSessions: false, mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'accounts') } });
  try {
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const post = async (route, data) => { const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(response.ok, true, await response.clone().text()); return response.json(); };
    const cards = await Promise.all(Array.from({ length: 20 }, (_, n) => post('/cards', { title: 'Concurrent ' + n })));
    assert.equal(new Set(cards.map(card => card.id)).size, 20);
    const requests = cards.flatMap(card => [post('/cards/note', { id: card.id, title: 'Note', text: 'Preserved content ' + card.id }), post('/cards/pin', { id: card.id, pinned: true })]);
    await Promise.all(requests);
    const invalid = await fetch(service.origin + '/api/cards/status', { method: 'POST', headers, body: JSON.stringify({ id: cards[0].id, status: 'invalid' }) }); assert.equal(invalid.ok, false);
    await post('/cards/status', { id: cards[0].id, status: 'done' });
    const registry = JSON.parse(await readFile(service.projects.workspacePath, 'utf8')); assert.equal(registry.entities.length, 20);
    for (const card of registry.entities) {
      assert.equal(card.pinned, true); assert.equal(card.steps.length, 1);
      assert.equal(await readFile(path.join(repo, 'workspace', card.folder, card.steps[0].path), 'utf8'), 'Preserved content ' + card.id);
    }
    assert.equal(registry.entities.find(card => card.id === cards[0].id).status, 'done');
  } finally { await service.close(); }
});
