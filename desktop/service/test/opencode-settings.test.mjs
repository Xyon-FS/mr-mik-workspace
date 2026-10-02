import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeSettings, openCodeDocument } from '../opencode-settings.mjs';
import { Projects } from '../projects.mjs';
import { McpInventory } from '../mcp.mjs';
import { WorkspaceBridge } from '../workspace-bridge.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-opencode-settings-')));
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), linked = path.join(base, 'Unity'), other = path.join(base, 'Blender'), stateDir = path.join(repo, '.mrmak');
  for (const folder of [path.join(repo, 'workspace'), path.join(repo, '.agents/skills/report'), stateDir, path.join(home, '.config/opencode'), linked, other]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(repo, '.agents/skills/report/SKILL.md'), '---\nname: report\ndescription: Fixture reporting\n---\nFixture instructions.');
  const projects = new Projects(repo, stateDir);
  const project = await projects.save({ name: 'Fixture Game', repositoryPath: linked });
  const repository = await projects.saveRepository({ projectId: project.id, name: 'Blender', repositoryPath: other });
  const globalFile = path.join(home, '.config/opencode/opencode.jsonc');
  const original = '// keep comment\n{\n "model": "fixture/test",\n "provider": {"private": {"secret": "fixture-secret"}},\n "mcp": {"fixture": {"type": "local", "command": ["node", "fixture.mjs"], "environment": {"AUTH": "fixture-secret"}, "enabled": true}},\n "plugin": ["fixture-plugin", "https://user:fixture-secret@example.test/plugin?token=fixture-secret"],\n}\n';
  await writeFile(globalFile, original);
  const settings = new OpenCodeSettings(projects, stateDir, { home, env: {} });
  return { base, repo, home, linked, other, stateDir, projects, project, repository, globalFile, original, settings };
}

test('OpenCode external MCP toggles preserve JSONC comments/secrets and isolate linked projects', async () => {
  const f = await fixture();
  const change = (scope, enabled, repositoryId = 'primary') => f.settings.change({ projectId: f.project.id, repositoryId, scope, kind: 'mcp', id: 'fixture', enabled });
  await change('global', false);
  const global = await readFile(f.globalFile, 'utf8'); assert.match(global, /keep comment/); assert.match(global, /fixture-secret/);
  await change('project', true);
  assert.equal((await f.settings.list(f.project.id, 'primary')).rows.find(row => row.kind === 'mcp').effective, true);
  assert.equal((await f.settings.list(f.project.id, f.repository.id)).rows.find(row => row.kind === 'mcp').effective, false);
  assert.deepEqual((await openCodeDocument(path.join(f.linked, 'opencode.json'))).value.mcp.fixture, { enabled: true });
  await change('project', null);
  assert.equal((await openCodeDocument(path.join(f.linked, 'opencode.json'))).value.mcp.fixture, undefined);
  assert.equal((await f.settings.list(f.project.id, 'primary')).rows.find(row => row.kind === 'mcp').effective, false);
  assert.equal(JSON.stringify(await f.settings.list(f.project.id, 'primary')).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(await f.settings.managed(null, null, 'global')).includes('fixture-secret'), false);
  assert.ok((await readdir(path.join(f.stateDir, 'opencode-config-backups'))).length > 0);
});

test('OpenCode definitions require ownership for destructive edits; malformed/custom/link sources are protected', async () => {
  const f = await fixture();
  await assert.rejects(f.settings.change({ scope: 'global', action: 'remove', name: 'fixture' }), /outside Mr. Mik/);
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', action: 'save', name: 'owned', transport: 'stdio', command: 'node', args: ['fixture.mjs'] });
  assert.equal((await f.settings.managed(f.project.id, 'primary')).servers.find(item => item.name === 'owned').managed, true);
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', action: 'toggle', name: 'owned', enabled: false });
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', action: 'remove', name: 'owned' });
  const custom = new OpenCodeSettings(f.projects, f.stateDir, { home: f.home, env: { OPENCODE_CONFIG_CONTENT: '{}' } });
  assert.equal((await custom.list()).rows.find(item => item.kind === 'mcp').globalEditable, false);
  await assert.rejects(custom.change({ scope: 'global', name: 'fixture', enabled: false }), /takes precedence/);
  await writeFile(f.globalFile, '{ invalid');
  await assert.rejects(f.settings.change({ scope: 'global', name: 'fixture', enabled: false }), /invalid/);
  assert.equal(await readFile(f.globalFile, 'utf8'), '{ invalid');
  for (const invalid of [{ mcp: { fixture: null } }, { permission: { skill: [] } }]) {
    const source = JSON.stringify(invalid); await writeFile(f.globalFile, source);
    await assert.rejects(f.settings.change({ scope: 'global', name: 'fixture', enabled: false }), /invalid/);
    assert.equal(await readFile(f.globalFile, 'utf8'), source);
  }
  await writeFile(f.globalFile, f.original);
  const alias = path.join(f.other, '.opencode'); await symlink(f.linked, alias, 'junction');
  await writeFile(path.join(f.linked, 'opencode.json'), '// exact source\n{}');
  await assert.rejects(f.projects.createSkill({ target: 'linked', agent: 'opencode', projectId: f.project.id, repositoryId: f.repository.id, name: 'unsafe', description: 'Fixture', instructions: 'Fixture' }), /regular folder/);
});

test('OpenCode Hub scopes are independent and native skill creation creates only .opencode in the chosen folder', async () => {
  const f = await fixture();
  await f.projects.setHubSkillScope({ agent: 'opencode', id: 'report', scope: 'global', enabled: true });
  await f.projects.setHubSkillScope({ agent: 'opencode', id: 'report', scope: 'project', projectId: f.project.id, enabled: false });
  assert.equal((await f.projects.hubSkills(f.project.id, 'opencode'))[0].effective, false);
  assert.equal((await f.projects.hubSkills(null, 'opencode'))[0].effective, true);
  assert.equal((await f.projects.hubSkills(null, 'codex'))[0].effective, false);
  const native = await f.projects.createSkill({ target: 'linked', agent: 'opencode', projectId: f.project.id, repositoryId: 'primary', name: 'native-report', description: 'Fixture', instructions: 'Fixture native instructions' });
  assert.equal(native.path, path.join(f.linked, '.opencode/skills/native-report/SKILL.md'));
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', kind: 'skill', id: 'native-report', enabled: false });
  assert.equal((await openCodeDocument(path.join(f.linked, 'opencode.json'))).value.permission.skill['native-report'], 'deny');
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', kind: 'skill', id: 'native-report', enabled: null });
  assert.equal((await openCodeDocument(path.join(f.linked, 'opencode.json'))).value.permission.skill['native-report'], undefined);
});

test('OpenCode MCP inventory merges sparse overrides without losing transport and hides credentials', async () => {
  const f = await fixture();
  await f.settings.change({ projectId: f.project.id, repositoryId: 'primary', id: 'fixture', enabled: false });
  const inventory = new McpInventory(f.linked, { home: f.home, env: {} });
  try {
    const listed = await inventory.list(), server = listed.servers.find(item => item.client === 'opencode' && item.name === 'fixture');
    assert.equal(server.enabled, false); assert.equal(server.transport, 'stdio'); assert.equal(server.sources.length, 2);
    assert.equal(JSON.stringify(listed).includes('fixture-secret'), false);
  } finally { inventory.close(); }
});

test('OpenCode Bridge uses the same approved skill/MCP services and snapshot preserves workspace scopes', async () => {
  const f = await fixture();
  const bridge = new WorkspaceBridge(f.projects, {}, async () => ({ entities: [] }), { openCodeSettings: f.settings });
  const token = bridge.issue('fixture-chat', f.project.id, null, 'primary', 'opencode');
  await assert.rejects(bridge.call(token, 'mrmak_manage_tool', { action: 'opencode-switch', name: 'fixture', scope: 'project', enabled: false }), /approval/);
  await bridge.call(token, 'mrmak_manage_tool', { action: 'opencode-switch', name: 'fixture', scope: 'project', enabled: false, confirmed: true });
  await bridge.call(token, 'mrmak_manage_skill', { action: 'scope', id: 'report', scope: 'workspace', enabled: true, confirmed: true });
  await f.projects.setHubSkillScope({ agent: 'codex', id: 'report', scope: 'project', projectId: f.project.id, enabled: true });
  assert.equal((await bridge.call(token, 'mrmak_skill_settings', {})).hub[0].effective, true);
  const snapshots = new WorkspaceSnapshot(f.repo, f.stateDir, f.projects);
  const exported = await snapshots.exportTo(f.base, f.project.id);
  const manifest = JSON.parse(await readFile(path.join(exported.path, 'mik-workspace.json'), 'utf8'));
  assert.equal(manifest.skills.opencode[0].enabled, true);
  assert.ok(manifest.files.some(item => item.name.startsWith('skills/opencode/report/')));
  assert.equal(JSON.stringify(manifest).includes('fixture-secret'), false);
  const destination = path.join(f.base, 'imported-hub'), stateDir = path.join(destination, '.mrmak');
  await mkdir(path.join(destination, 'workspace'), { recursive: true });
  await writeFile(path.join(destination, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
  const projects = new Projects(destination, stateDir), imported = new WorkspaceSnapshot(destination, stateDir, projects);
  await imported.importFrom(exported.path);
  assert.equal((await projects.hubSkills(f.project.id, 'opencode'))[0].effective, true);
  assert.equal((await projects.hubSkills(f.project.id, 'codex'))[0].effective, true);
  assert.equal(await readFile(path.join(destination, '.agents/skills/report/SKILL.md'), 'utf8'), await readFile(path.join(f.repo, '.agents/skills/report/SKILL.md'), 'utf8'));
});
