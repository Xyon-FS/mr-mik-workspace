import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import path from 'node:path';
import os from 'node:os';
import { Projects } from '../projects.mjs';
import { WorkspaceBridge, bridgeTools } from '../workspace-bridge.mjs';
import { hubContentDirectories } from '../hub-files.mjs';
import { codexAllowsAdditionalDirectories } from '../chat-orientation.mjs';

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-native-hub-'));
  for (const folder of ['workspace', 'knowledge', 'processes', 'context']) await mkdir(path.join(repo, folder));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const registry = async () => JSON.parse(await readFile(projects.workspacePath, 'utf8'));
  const bridge = new WorkspaceBridge(projects, {}, registry);
  const card = await projects.createCard({ title: 'Bird study' });
  const token = bridge.issue('chat', null, card.id);
  return { repo, projects, bridge, registry, card, token };
}

test('destination prepares no content; native file is registered once without transporting bytes', async () => {
  const f = await fixture();
  const target = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', title: 'Birds' });
  await assert.rejects(readFile(target.path), { code: 'ENOENT' });
  assert.equal((await f.registry()).entities[0].steps.length, 0);
  await assert.rejects(f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: target.destinationId }));
  const html = '<html><body>Bird study</body></html>';
  await writeFile(target.path, html);
  for (let i = 0; i < 2; i++) await f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: target.destinationId });
  assert.equal((await f.registry()).entities[0].steps.length, 1);
  assert.equal(await readFile(target.path, 'utf8'), html);
  const existing = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', path: path.basename(target.path) });
  assert.equal(existing.exists, true); assert.equal(existing.path, target.path); assert.equal(existing.revision.length, 64);
  assert.ok(!('html' in existing)); assert.ok(!('text' in existing));
  const overview = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card' });
  assert.equal(overview.directory, true); assert.equal(overview.pages[0].path, target.path);
  for (const name of ['mrmak_add_card_page', 'mrmak_update_card_page', 'mrmak_add_card_note', 'mrmak_create_resource', 'mrmak_update_resource']) {
    assert.ok(!bridgeTools.some(tool => tool.name === name));
    await assert.rejects(f.bridge.call(f.token, name, {}), /Unsupported/);
  }
  const libraryTarget = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'knowledge', title: 'Long bird study' });
  await writeFile(libraryTarget.path, '# Birds\n' + 'observation\n'.repeat(3000));
  const item = await f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: libraryTarget.destinationId });
  const existingLibrary = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'knowledge', id: item.id });
  assert.equal(existingLibrary.path, libraryTarget.path); assert.ok(!('text' in existingLibrary));
  await writeFile(existingLibrary.path, (await readFile(existingLibrary.path, 'utf8')).replace('# Birds', '# Updated birds'));
  await f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: existingLibrary.destinationId });
  assert.match(await readFile(existingLibrary.path, 'utf8'), /^# Updated birds/);
  const other = f.bridge.issue('other', null);
  await assert.rejects(f.bridge.call(other, 'mrmak_register_hub_file', { destinationId: target.destinationId }), /this chat/);
  await assert.rejects(f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', path: '../outside.html' }), /registered/);
  const reassigned = await f.bridge.call(f.token, 'mrmak_hub_destination', { kind: 'card', title: 'New bird notes' });
  await writeFile(reassigned.path, '<html>Birds</html>');
  await f.projects.editWorkspace(registry => { registry.entities[0].projectId = 'another'; });
  await assert.rejects(f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: reassigned.destinationId }), /association changed/);
  assert.equal(await readFile(reassigned.path, 'utf8'), '<html>Birds</html>');
  f.bridge.revoke('chat');
  await assert.rejects(f.bridge.call(f.token, 'mrmak_register_hub_file', { destinationId: target.destinationId }), /expired/);
});

test('additional Codex roots never force read-only or custom profiles into workspace-write', async () => {
  const f = await fixture(), home = path.join(f.repo, 'home'); await mkdir(home);
  assert.equal(await codexAllowsAdditionalDirectories(home, f.repo), false);
  await writeFile(path.join(home, 'config.toml'), 'sandbox_mode = "workspace-write"');
  assert.equal(await codexAllowsAdditionalDirectories(home, f.repo), true);
  await writeFile(path.join(home, 'config.toml'), 'sandbox_mode = "read-only"');
  assert.equal(await codexAllowsAdditionalDirectories(home, f.repo), false);
  await writeFile(path.join(home, 'config.toml'), 'sandbox_mode = "workspace-write"\nprofile = "restricted"');
  assert.equal(await codexAllowsAdditionalDirectories(home, f.repo), false);
  const roots = await hubContentDirectories(f.projects, (await f.registry()).entities, null);
  assert.ok(!roots.includes(f.repo)); assert.ok(!roots.some(root => root.endsWith('.mrmak')));
});
