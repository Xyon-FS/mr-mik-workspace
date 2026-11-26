import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { defaultWorkerEfforts, claudeEfforts } from '../effort.mjs';

test('reasoning defaults remain editable without system login or native model discovery, preserving an active coordinator', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-reasoning-defaults-')), repo = path.join(root, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: path.join(root, 'ui'), mcpOptions: { home: path.join(root, 'home'), env: {} } });
  t.after(() => service.close());
  const coordinator = service.coordinator;
  const active = { operationId: 'synthetic-active-operation', reject() {} }; coordinator.active = active;
  coordinator.runtimeProfileId = 'synthetic-selected-account';
  coordinator.start = async () => { throw new Error('Settings must not start or switch a native runtime'); };
  coordinator.rpc = async () => { throw new Error('Settings must not inspect a native model'); };
  const request = async (route, data) => {
    const response = await fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal(response.ok, true); return response.json();
  };
  const defaults = await request('/reasoning?scope=defaults&profileId=system');
  assert.deepEqual(defaults.codex.efforts, defaultWorkerEfforts); assert.deepEqual(defaults.codexWorker.efforts, defaultWorkerEfforts); assert.deepEqual(defaults.claude.efforts, claudeEfforts);
  assert.equal(defaults.error, undefined); assert.equal(coordinator.active, active); assert.equal(coordinator.runtimeProfileId, 'synthetic-selected-account');
  await request('/settings', { defaultWorkerEffort: 'high', coordinatorEffort: 'xhigh' });
  assert.equal(coordinator.settings().defaultWorkerEffort, 'high'); assert.equal(coordinator.settings().coordinatorEffort, 'xhigh');
  assert.equal(coordinator.active, active); coordinator.active = null;
  const calls = [];
  service.coordinator.reasoningCapabilities = async (model, options) => { calls.push({ model, ...options }); return { model: model || 'native-default', efforts: ['medium'], defaultEffort: 'medium' }; };
  const result = await request('/reasoning?scope=model&profileId=chosen-profile&model=chosen-model'); assert.deepEqual(result.codex.efforts, ['medium']);
  assert.deepEqual(calls, [{ model: 'chosen-model', profileId: 'chosen-profile' }, { model: undefined, worker: true, profileId: 'chosen-profile' }]);
});

test('Claude permission defaults persist independently and affect only newly created chats', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-permission-defaults-')), repo = path.join(root, 'hub');
  await mkdir(repo);
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: path.join(root, 'home'), env: {} } });
  t.after(() => service.close());
  service.sessions.launch = async session => { session.status = 'running'; };
  const request = async (route, data) => {
    const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.ok, true, await response.clone().text()); return response.json();
  };
  await request('/settings', { defaultBypass: true, defaultClaudePermissions: 'ask', defaultCodexPermissions: 'auto-review' });
  const existing = await request('/sessions', { agent: 'claude', cwd: repo });
  assert.equal(existing.bypass, false);
  const openCode = await request('/sessions', { agent: 'opencode', cwd: repo });
  assert.equal(openCode.bypass, true);
  await request('/settings', { defaultBypass: false, defaultClaudePermissions: 'bypass' });
  assert.equal(service.sessions.get(existing.id).bypass, false);
  assert.equal((await request('/sessions', { agent: 'claude', cwd: repo })).bypass, true);
  assert.equal((await request('/sessions', { agent: 'claude', cwd: repo, bypass: false })).bypass, false);
  assert.equal(service.coordinator.settings().defaultCodexPermissions, 'auto-review');
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(repo, '.mrmak/settings.json'), 'utf8'));
  assert.equal(saved.defaultClaudePermissions, 'bypass'); assert.equal(saved.defaultBypass, false);
});
