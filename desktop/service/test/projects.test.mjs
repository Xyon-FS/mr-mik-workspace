import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink, realpath, rename } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Projects } from '../projects.mjs';
import { Workspace } from '../workspace.mjs';
import { WorkspaceBridge, bridgeTools } from '../workspace-bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexBridgeArgs, commandPath, terminalCommand } from '../agents.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-projects-'));
  const repo = path.join(base, 'hub'), external = path.join(base, 'external'), other = path.join(base, 'other');
  for (const folder of [repo, external, other, ...['workspace', 'context', 'knowledge', 'processes', 'inbox', 'ui'].map(folder => path.join(repo, folder))]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'legacy', title: 'Legacy', folder: 'legacy', steps: [], status: 'active' }], preserved: true }));
  await writeFile(path.join(repo, 'knowledge/general.md'), '# General lesson');
  await writeFile(path.join(repo, 'knowledge/specific.md'), '# Specific lesson');
  await writeFile(path.join(repo, 'processes/release.md'), '# Release workflow');
  await writeFile(path.join(repo, 'inbox/reference.txt'), 'original bytes');
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const a = await projects.save({ name: 'Exercise', repositoryPath: external });
  const b = await projects.save({ name: 'PumpDown', repositoryPath: other });
  const registry = async () => JSON.parse(await readFile(projects.workspacePath, 'utf8'));
  const bridge = new WorkspaceBridge(projects, new Workspace(repo), registry);
  return { repo, external, other, projects, a, b, bridge, registry };
}

async function author(bridge, token, args, content) {
  const destination = await bridge.call(token, 'mrmak_hub_destination', args);
  await writeFile(destination.path, content);
  return bridge.call(token, 'mrmak_register_hub_file', { destinationId: destination.destinationId });
}

test('registration separates portable metadata from local locations and never copies or deletes repositories', async () => {
  const f = await fixture();
  assert.equal((await f.projects.inspect(f.a.id)).branch, null);
  assert.deepEqual(await readdir(f.external), []);
  assert.doesNotMatch(await readFile(f.projects.registryPath, 'utf8'), /repositoryPath/);
  await assert.rejects(f.projects.save({ name: 'Duplicate', repositoryPath: f.external }), /already registered/);
  await assert.rejects(f.projects.save({ name: 'Nested', repositoryPath: f.repo }), /external/);
  await f.projects.remove(f.a.id);
  assert.deepEqual(await readdir(f.external), []);
  assert.equal((await f.registry()).entities[0].id, 'legacy');
  await writeFile(f.projects.registryPath, '{invalid');
  await assert.rejects(f.projects.save({ name: 'Retain', repositoryPath: f.external }), /Registry/);
  assert.equal(await readFile(f.projects.registryPath, 'utf8'), '{invalid');
});

test('card workspace and linked-project associations save together and reject invalid pairs without changes', async () => {
  const f = await fixture();
  const card = await f.projects.createCard({ projectId: f.a.id, repositoryId: 'primary', title: 'Association fixture' });
  await f.projects.assignCard(card.id, f.b.id, 'primary');
  const current = () => f.registry().then(registry => registry.entities.find(item => item.id === card.id));
  assert.deepEqual([(await current()).projectId, (await current()).repositoryId], [f.b.id, 'primary']);
  await assert.rejects(f.projects.assignCard(card.id, f.a.id, 'missing'), /not linked/);
  await assert.rejects(f.projects.assignCard(card.id, null, 'primary'), /not linked/);
  assert.deepEqual([(await current()).projectId, (await current()).repositoryId], [f.b.id, 'primary']);
  await f.projects.assignCard(card.id, f.a.id);
  assert.equal((await current()).repositoryId, null);
  await f.projects.assignCard(card.id, f.b.id, null);
  const folder = path.join(path.dirname(f.external), 'queued-linked');
  await mkdir(folder);
  const linked = await f.projects.saveRepository({ projectId: f.a.id, name: 'Queued', repositoryPath: folder });
  let release;
  const gate = f.projects.serialize(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const removing = f.projects.removeRepository({ projectId: f.a.id, repositoryId: linked.id });
  const assigning = f.projects.assignCard(card.id, f.a.id, linked.id);
  release(); await gate;
  await removing;
  await assert.rejects(assigning, /not linked/);
  assert.equal((await current()).projectId, f.b.id);
  assert.equal((await current()).repositoryId, null);
  await f.projects.assignCard(card.id, null, null);
  assert.deepEqual([(await current()).projectId, (await current()).repositoryId], [null, null]);
});

test('unlinking the main linked project requires a replacement and does not silently retarget Hub links', async () => {
  const f = await fixture(), blender = path.join(path.dirname(f.external), 'blender');
  await mkdir(blender);
  await writeFile(path.join(f.external, 'architecture.md'), '# Original architecture');
  const linked = await f.projects.saveRepository({ projectId: f.a.id, name: 'Blender', repositoryPath: blender });
  const card = await f.projects.createCard({ projectId: f.a.id, repositoryId: 'primary', title: 'Development' });
  await f.projects.linkArtifact({ projectId: f.a.id, id: card.id, path: 'architecture.md' });
  const document = await f.projects.linkDocument({ projectId: f.a.id, path: 'architecture.md' });
  await assert.rejects(f.projects.removeRepository({ projectId: f.a.id, repositoryId: 'primary' }), /Choose another linked project/);
  const service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui') });
  try {
    const session = service.sessions.make({ id: randomUUID(), name: 'Blender chat', agent: 'codex', cwd: blender, projectId: f.a.id, repositoryId: linked.id, open: true, status: 'stopped', createdAt: new Date().toISOString() });
    service.sessions.items.set(session.id, session);
    const response = await fetch(`${service.origin}/api/projects/repositories/remove`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: f.a.id, repositoryId: linked.id }) });
    assert.equal(response.status, 409);
    assert.equal((await f.projects.get(f.a.id)).repositories.length, 2);
  } finally { service.sessions.items.clear(); await service.close(); }
  const result = await f.projects.removeRepository({ projectId: f.a.id, repositoryId: 'primary', replacementId: linked.id });
  assert.deepEqual([result.affectedCards, result.removedArtifacts, result.removedDocuments], [1, 1, 1]);
  assert.equal((await f.projects.get(f.a.id)).repositories[0].id, linked.id);
  assert.equal(await f.projects.root(f.a.id), await realpath(blender));
  assert.equal((await f.registry()).entities.find(item => item.id === card.id).projectId, f.a.id);
  assert.equal((await f.registry()).resources.some(item => item.id === document.id), false);
  assert.equal(await readFile(path.join(f.external, 'architecture.md'), 'utf8'), '# Original architecture');
  await writeFile(path.join(blender, 'architecture.md'), '# Blender architecture');
  const newDocument = await f.projects.linkDocument({ projectId: f.a.id, path: 'architecture.md' });
  assert.equal(newDocument.repositoryId, linked.id);
  assert.equal(await readFile(await f.projects.resourceLocation(newDocument), 'utf8'), '# Blender architecture');
  await f.projects.save({ id: f.a.id, name: 'Exercise renamed', repositoryPath: blender });
  assert.deepEqual((await f.projects.get(f.a.id)).repositories.map(item => item.id), [linked.id]);
});

test('one logical project links independent repositories and cards retain Hub-only pages and assets', async () => {
  const f = await fixture(), blender = path.join(path.dirname(f.external), 'blender');
  await mkdir(blender);
  const linked = await f.projects.saveRepository({ projectId: f.a.id, name: 'Blender', repositoryPath: blender });
  assert.equal(await f.projects.root(f.a.id, linked.id), await realpath(blender));
  assert.equal((await f.projects.get(f.a.id)).repositories.length, 2);
  assert.doesNotMatch(await readFile(f.projects.registryPath, 'utf8'), /repositoryPath/);
  await writeFile(path.join(blender, 'model.txt'), 'model source');
  const card = await f.projects.createCard({ projectId: f.a.id, repositoryId: linked.id, title: '3D models', category: 'research' });
  assert.equal(card.category, 'research');
  await assert.rejects(f.projects.createCard({ projectId: f.a.id, title: 'Invalid', category: 'unknown' }), /supported card category/);
  const token = f.bridge.issue('blender-chat', f.a.id, card.id, linked.id);
  const context = await f.bridge.call(token, 'mrmak_chat_context');
  assert.equal(context.project.name, 'Exercise');
  const textures = await f.bridge.call(token, 'mrmak_create_card', { title: 'Textures', category: 'image-gen' });
  assert.equal(textures.repositoryId, linked.id);
  assert.equal(textures.category, 'image-gen');
  assert.equal(context.workingRepository.id, linked.id);
  assert.equal(context.card.id, card.id);
  assert.equal(context.repositories.length, 2);
  assert.ok((await f.bridge.call(token, 'mrmak_list_repositories')).some(item => item.id === linked.id && item.cards[0].id === card.id));
  assert.equal((await f.bridge.call(token, 'mrmak_list_cards'))[0].selected, true);
  assert.equal((await f.bridge.call(token, 'mrmak_read_repository_file', { repositoryId: linked.id, path: 'model.txt' })).text, 'model source');
  const page = await author(f.bridge, token, { kind: 'card', id: card.id, title: 'Models' }, '<!doctype html><html><body>Models</body></html>');
  await author(f.bridge, token, { kind: 'card', id: card.id, path: page.path }, '<!doctype html><html><body>Updated models</body></html>');
  assert.match(await readFile(path.join(f.repo, 'workspace', card.folder, page.path), 'utf8'), /Updated models/);
  await assert.rejects(f.bridge.call(token, 'mrmak_update_card_page', { id: card.id, path: '../other.html', html: '<html>Bad</html>' }));
  const asset = await f.bridge.call(token, 'mrmak_import_card_asset', { id: card.id, repositoryId: linked.id, path: 'model.txt' });
  assert.match(page.path, /\.html$/);
  assert.match(asset.path, /^assets\//);
  assert.equal((await f.registry()).entities.find(item => item.id === card.id).steps.length, 1);
  assert.deepEqual(await readdir(blender), ['model.txt']);
  await assert.rejects(f.bridge.call(token, 'mrmak_read_repository_file', { repositoryId: linked.id, path: '../hub/workspace/workspace.json' }));
});

test('skill creation separates Hub and linked folders, creates missing roots, and never overwrites', async () => {
  const f = await fixture();
  const base = { agent: 'codex', name: 'new-handoff', description: 'Use for handoffs.', instructions: '# Handoff\n\nCheck the destination.' };
  const hub = await f.projects.createSkill({ ...base, target: 'hub' });
  assert.match(hub.path, /\.agents[\\/]skills[\\/]new-handoff[\\/]SKILL\.md$/);
  assert.match(await readFile(hub.path, 'utf8'), /description: "Use for handoffs\."/);
  assert.deepEqual(await readdir(f.external), []);
  const linked = await f.projects.createSkill({ ...base, agent: 'claude', target: 'linked', projectId: f.a.id, repositoryId: 'primary' });
  assert.match(linked.path, /external[\\/]\.claude[\\/]skills[\\/]new-handoff[\\/]SKILL\.md$/);
  assert.deepEqual(await readdir(f.other), []);
  await assert.rejects(f.projects.createSkill({ ...base, agent: 'claude', target: 'linked', projectId: f.a.id, repositoryId: 'primary' }), /already exists/);
  await assert.rejects(f.projects.createSkill({ ...base, target: 'linked', projectId: f.a.id }), /Choose a linked project/);
  await assert.rejects(f.projects.createSkill({ ...base, target: 'hub', name: '../escape' }), /Provide a skill name/);
  await symlink(f.external, path.join(f.other, '.agents'), 'junction');
  await assert.rejects(f.projects.createSkill({ ...base, target: 'linked', projectId: f.b.id, repositoryId: 'primary' }), /not a regular folder/);
});

test('selected file is copied to the Hub project library; external repository stays unchanged', async () => {
  const f = await fixture();
  const source = path.join(f.external, 'reference.pdf');
  await writeFile(source, 'original content');
  const first = await f.projects.importResource({ kind: 'knowledge', projectId: f.a.id, source });
  const second = await f.projects.importResource({ kind: 'knowledge', projectId: f.a.id, source });
  assert.notEqual(first.path, second.path);
  assert.match(first.path, new RegExp(`^knowledge/projects/${f.a.id}/`));
  assert.equal((await f.projects.resources('knowledge', f.a.id, 'project')).length, 2);
  assert.equal((await f.projects.resources('knowledge', f.b.id, 'project')).length, 0);
  assert.equal(await readFile(source, 'utf8'), 'original content');
  assert.equal(await readFile(path.join(f.repo, first.path), 'utf8'), 'original content');
  const intake = await f.projects.importResource({ kind: 'inbox', projectId: f.a.id, source });
  assert.match(intake.path, /^inbox\/reference\.pdf$/);
  assert.equal((await f.projects.resources('inbox', f.a.id, 'project')).length, 1);
  assert.equal((await f.projects.resources('inbox', f.b.id, 'project')).length, 0);
  assert.deepEqual(await readdir(f.external), ['reference.pdf']);
  await mkdir(path.join(f.external, 'docs'));
  const externalDocument = path.join(f.external, 'docs/architecture.md');
  await writeFile(externalDocument, '# External source');
  const knowledge = path.join(f.repo, 'knowledge');
  const contentBefore = (await readdir(knowledge, { recursive: true })).sort();
  const linked = await f.projects.linkDocument({ projectId: f.a.id, path: 'docs/architecture.md' });
  assert.deepEqual((await readdir(knowledge, { recursive: true })).sort(), contentBefore);
  assert.equal((await f.projects.readResource('knowledge', linked.id, f.a.id)).text, '# External source');
  await assert.rejects(f.projects.readResource('knowledge', linked.id, f.b.id), /not available/);
  await assert.rejects(f.projects.linkDocument({ projectId: f.a.id, path: '../hub/knowledge/general.md' }));
  await assert.rejects(f.projects.linkDocument({ projectId: f.a.id, path: '.codex/auth.md' }));
  assert.equal(await readFile(externalDocument, 'utf8'), '# External source');
  await writeFile(path.join(f.external, 'private.md'), 'outside');
  await symlink(f.external, path.join(f.repo, 'knowledge/linked'), 'junction');
  await assert.rejects(f.projects.assignResource({ kind: 'knowledge', path: 'knowledge/linked/private.md', projectId: f.a.id }), /leaves/);
  assert.equal((await f.projects.unlinkResource('knowledge', linked.id)).sourceUntouched, true);
  assert.equal(await readFile(externalDocument, 'utf8'), '# External source');
  assert.equal((await f.projects.resources('knowledge', f.a.id, 'project')).some(item => item.id === linked.id), false);

  const entry = await f.projects.assignResource({ kind: 'knowledge', path: 'knowledge/specific.md', projectId: f.a.id });
  const original = path.join(f.repo, entry.path);
  const moved = path.join(f.repo, 'ui', 'moved-resource.md');
  await rename(original, moved);
  assert.deepEqual(await f.projects.cleanupRecycledResource(original), { removed: 1 });
  assert.equal((await f.projects.resources('knowledge', f.a.id, 'project')).some(item => item.id === entry.id), false);
  assert.equal(await readFile(moved, 'utf8'), '# Specific lesson');
});

test('Bridge isolates cards and resources, denies general operations and revokes old capabilities', async () => {
  const f = await fixture();
  const card = await f.projects.createCard({ projectId: f.a.id, title: 'Gameplay' });
  await writeFile(path.join(f.external, 'artifact.txt'), 'fixture artifact');
  const token = f.bridge.issue('chat', f.a.id), other = f.bridge.issue('other-chat', f.b.id);
  assert.equal((await f.bridge.call(token, 'mrmak_list_cards')).length, 1);
  await assert.rejects(f.bridge.call(other, 'mrmak_read_card', { id: card.id }), /not available/);
  await assert.rejects(f.bridge.call(token, 'read_file', { path: '.env' }), /Unsupported/);
  await assert.rejects(f.bridge.call(token, 'mrmak_read_card', { id: card.id, projectId: f.b.id }), /Unsupported/);
  const note = await author(f.bridge, token, { kind: 'card', id: card.id, title: 'Result', format: 'markdown' }, '# Verified result');
  const artifact = await f.bridge.call(token, 'mrmak_link_artifact', { id: card.id, path: 'artifact.txt' });
  assert.equal(artifact.path, 'artifact.txt');
  assert.equal(await f.projects.artifactLocation(f.a.id, card.id, artifact.path), await realpath(path.join(f.external, 'artifact.txt')));
  await assert.rejects(f.bridge.call(other, 'mrmak_link_artifact', { id: card.id, path: 'artifact.txt' }), /not available|Choose a card/);
  await assert.rejects(f.bridge.call(token, 'mrmak_link_artifact', { id: card.id, path: '../hub/workspace/workspace.json' }), /leaves|private|relative/i);
  assert.equal(note.registered, true);
  await f.bridge.call(token, 'mrmak_update_card', { id: card.id, status: 'done' });
  assert.equal((await f.registry()).entities.find(item => item.id === card.id).status, 'done');
  f.bridge.issue('chat', f.a.id);
  await assert.rejects(f.bridge.call(token, 'mrmak_list_cards'), /expired/);
  await f.projects.remove(f.b.id);
  await assert.rejects(f.bridge.call(other, 'mrmak_list_cards'), /not registered/);
});

test('Bridge uses the selected card and keeps global and workspace library writes separate', async () => {
  const f = await fixture();
  const card = await f.projects.createCard({ projectId: f.a.id, title: 'Gameplay' });
  const project = f.bridge.issue('project-chat', f.a.id, card.id);
  const page = await author(f.bridge, project, { kind: 'card', title: 'Progress' }, '<html><body>Progress</body></html>');
  assert.equal(page.id, card.id);
  const lesson = await author(f.bridge, project, { kind: 'knowledge', title: 'Local lesson' }, '# Local lesson');
  assert.equal(lesson.projectId, f.a.id);
  assert.match((await readFile(path.join(f.repo, lesson.path), 'utf8')), /Local lesson/);
  const readLesson = await f.bridge.call(project, 'mrmak_read_resource', { kind: 'knowledge', id: lesson.id });
  await author(f.bridge, project, { kind: 'knowledge', id: lesson.id }, '# Improved lesson');
  assert.match((await readFile(path.join(f.repo, lesson.path), 'utf8')), /Improved lesson/);
  await assert.rejects(f.bridge.call(project, 'mrmak_update_resource', { kind: 'knowledge', id: lesson.id, text: '# Stale edit', expectedRevision: readLesson.revision }), /Unsupported/);
  const shared = await author(f.bridge, project, { kind: 'process', title: 'Shared process', scope: 'global' }, '# Shared process');
  assert.equal(shared.projectId, null);
  await assert.rejects(f.bridge.call(project, 'mrmak_hub_destination', { kind: 'process', id: shared.id }), /Choose Global/);
  await assert.rejects(f.bridge.call(project, 'mrmak_hub_destination', { kind: 'context', name: 'goals.md' }), /approval/);
  const saved = await author(f.bridge, project, { kind: 'context', name: 'goals.md', confirmed: true }, '# Goal');
  assert.equal((await f.bridge.call(project, 'mrmak_context', { action: 'read', name: 'goals.md' })).revision, saved.revision);
  await assert.rejects(f.bridge.call(project, 'mrmak_context', { action: 'save', name: 'goals.md', text: '# Changed', expectedRevision: null, confirmed: true }), /Unsupported/);
  await writeFile(path.join(f.external, 'reference.txt'), 'source');
  const inbox = await f.bridge.call(project, 'mrmak_import_inbox_file', { repositoryId: 'primary', path: 'reference.txt' });
  assert.equal(inbox.projectId, f.a.id);
  assert.equal((await f.bridge.call(project, 'mrmak_list_inbox')).some(item => item.id === inbox.id), true);
  const unassigned = await f.bridge.call(project, 'mrmak_assign_inbox', { id: inbox.id, scope: 'global' });
  assert.equal(unassigned.projectId, null);
  assert.equal(await readFile(path.join(f.external, 'reference.txt'), 'utf8'), 'source');
  const global = f.bridge.issue('global-chat', null);
  assert.equal((await f.bridge.call(global, 'mrmak_chat_context')).scope, 'global');
  assert.equal((await f.bridge.call(global, 'mrmak_list_workspaces')).length, 2);
  assert.equal((await f.bridge.call(global, 'mrmak_list_cards')).length, 1);
  assert.equal((await f.bridge.call(global, 'mrmak_search_library', { kind: 'knowledge' })).some(item => item.id === lesson.id), false);
  const globalCard = await f.bridge.call(global, 'mrmak_create_card', { title: 'Shared notes' });
  assert.equal(globalCard.projectId, null);
  assert.equal((await f.bridge.call(global, 'mrmak_list_cards')).some(item => item.id === globalCard.id), true);
  await assert.rejects(f.bridge.call(global, 'mrmak_hub_destination', { kind: 'card', title: 'Missing selection' }), /Choose a card/);
});

test('Bridge discovers and changes skills and MCP settings through the same scoped services as the UI', async () => {
  const f = await fixture(), home = path.join(f.repo, 'test-home');
  await mkdir(home);
  const service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } } });
  try {
    const token = service.bridge.issue('settings-chat', f.a.id, null, 'primary');
    await assert.rejects(service.bridge.call(token, 'mrmak_hub_destination', { kind: 'skill', target: 'hub', name: 'project-notes', confirmed: false }), /approval/);
    await author(service.bridge, token, { kind: 'skill', target: 'hub', name: 'project-notes', confirmed: true }, '---\nname: project-notes\ndescription: Keep project notes\n---\n# Notes');
    assert.equal((await service.bridge.call(token, 'mrmak_skill_settings')).hub.find(item => item.id === 'project-notes').effective, true);
    await service.bridge.call(token, 'mrmak_manage_skill', { action: 'scope', scope: 'workspace', id: 'project-notes', enabled: false, confirmed: true });
    assert.equal((await service.bridge.call(token, 'mrmak_skill_settings')).hub.find(item => item.id === 'project-notes').effective, false);
    await author(service.bridge, token, { kind: 'skill', target: 'linked', name: 'native-check', confirmed: true }, '---\nname: native-check\ndescription: Native check\n---\n# Check');
    assert.match(await readFile(path.join(f.external, '.agents/skills/native-check/SKILL.md'), 'utf8'), /Native check/);
    await assert.rejects(service.bridge.call(token, 'mrmak_manage_tool', { action: 'mcp-definition', agent: 'codex', scope: 'project', name: 'demo', transport: 'stdio', command: 'node', args: [], confirmed: false }), /approval/);
    await service.bridge.call(token, 'mrmak_manage_tool', { action: 'mcp-definition', agent: 'codex', scope: 'project', name: 'demo', transport: 'stdio', command: 'node', args: [], confirmed: true });
    assert.match(await readFile(path.join(f.external, '.codex/config.toml'), 'utf8'), /mcp_servers\."demo"/);
    assert.equal((await service.bridge.call(token, 'mrmak_tool_settings')).codex.some(item => item.id === 'demo' && item.kind === 'mcp'), true);
    assert.equal((await service.bridge.call(token, 'mrmak_tool_settings', { scope: 'global' })).scope, 'global');
    await service.bridge.call(token, 'mrmak_manage_tool', { action: 'codex-switch', scope: 'project', kind: 'mcp', name: 'demo', enabled: false, confirmed: true });
    assert.equal((await service.bridge.call(token, 'mrmak_tool_settings')).codex.find(item => item.id === 'demo').projectOverride, false);
    await service.bridge.call(token, 'mrmak_manage_tool', { action: 'mcp-definition', agent: 'claude', scope: 'project', name: 'claude-demo', transport: 'stdio', command: 'node', args: [], confirmed: true });
    assert.equal((await service.bridge.call(token, 'mrmak_tool_settings')).servers.some(item => item.name === 'claude-demo' && item.client === 'claude'), true);
  } finally { await service.close(); }
});

test('real MCP transport exposes only scoped tools and its capability cannot call application APIs', async () => {
  const f = await fixture();
  const skillFolder = path.join(f.repo, '.agents', 'skills', 'handoff');
  await mkdir(skillFolder, { recursive: true });
  await writeFile(path.join(skillFolder, 'SKILL.md'), '---\nname: handoff\ndescription: Make a handoff card when requested.\n---\n# Private full instructions\n');
  await f.projects.setHubSkillScope({ id: 'handoff', scope: 'project', projectId: f.a.id, enabled: true });
  const service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui') });
  const token = service.bridge.issue('fixture', f.a.id);
  const client = new Client({ name: 'bridge-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url))], env: { ...process.env, MRMAK_BRIDGE_URL: `${service.origin}/bridge`, MRMAK_BRIDGE_TOKEN: token }, stderr: 'ignore' });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions(), /Current Hub scope: workspace "Exercise"/);
    assert.doesNotMatch(client.getInstructions(), /handoff.*Make a handoff card/s);
    assert.doesNotMatch(client.getInstructions(), /Private full instructions/);
    assert.equal((await client.listTools()).tools.length, bridgeTools.length);
    const result = await client.callTool({ name: 'mrmak_search_library', arguments: { kind: 'knowledge' } });
    assert.equal(result.isError, undefined);
    assert.equal((await fetch(`${service.origin}/api/bootstrap`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    service.bridge.revoke('fixture');
    assert.equal((await client.callTool({ name: 'mrmak_list_cards', arguments: {} })).isError, true);
  } finally { await client.close(); await transport.close(); await service.close(); }
});

test('project chat resolves backend cwd, preserves native metadata and blocks silent redirection', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(), service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui') });
  try {
    const response = await fetch(`${service.origin}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'shell', projectId: f.a.id, cwd: f.other, name: 'Project Terminal' }) });
    assert.equal(response.status, 201); const session = await response.json();
    assert.equal(session.projectId, f.a.id); assert.equal(session.cwd, await f.projects.root(f.a.id));
    await service.sessions.remove(session.id);
    await service.projects.save({ id: f.a.id, name: f.a.name, repositoryPath: path.join(f.external, 'docs') }).catch(async () => {
      await mkdir(path.join(f.external, 'docs')); await service.projects.save({ id: f.a.id, name: f.a.name, repositoryPath: path.join(f.external, 'docs') });
    });
    await assert.rejects(service.sessions.resume(session.id), /location changed/);
    assert.equal(service.sessions.get(session.id).cwd, session.cwd);
    assert.doesNotMatch(await readFile(path.join(f.repo, '.mrmak/sessions.json'), 'utf8'), /MRMAK_BRIDGE_TOKEN/);
  } finally { await service.close(); }
});

test('installed Codex accepts invocation-only Bridge overrides without touching native user/project configs', { skip: !commandPath('codex') || !commandPath('codex').endsWith('.exe'), timeout: 20000 }, async () => {
  const f = await fixture(), home = path.join(f.repo, '.mrmak/codex-test-home'); await mkdir(home, { recursive: true });
  const script = fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url));
  const launch = terminalCommand('codex', { bridge: { script, instructions: 'Route Mr. Mik Hub pages through its Bridge.' } });
  assert.equal(launch.file, commandPath('codex'));
  assert.ok(launch.args.includes(`mcp_servers.mrmak_workspace.args=[${JSON.stringify(script)}]`));
  // app-server accepts configuration overrides, not interactive TUI permission
  // flags. Reusing the complete terminal command caused an immediate parse exit
  // which this test used to report as an eight-second RPC timeout.
  const child = spawn(launch.file, ['app-server', '--stdio', ...codexBridgeArgs(script), '-c', 'developer_instructions="Route Mr. Mik Hub pages through its Bridge."'], { cwd: f.external, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2000); });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const message = JSON.parse(line), resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } } catch { /* Only JSON-RPC is read. */ }
  });
  const rpc = async (method, params) => {
    const id = ++sequence; let timer;
    const exited = () => pending.get(id)?.({ error: { message: `Codex app-server exited before ${method}: ${diagnostic}` } });
    const failed = error => pending.get(id)?.({ error: { message: `Codex app-server could not start: ${error.message}` } });
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Isolated Codex protocol timed out at ${method}: ${diagnostic}`)), 8000);
        pending.set(id, message => message.error ? reject(new Error(message.error.message || 'Isolated Codex protocol rejected the request.')) : resolve(message.result));
        child.once('exit', exited); child.once('error', failed);
        if (child.exitCode !== null || child.signalCode !== null) return exited();
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally { clearTimeout(timer); pending.delete(id); child.off('exit', exited); child.off('error', failed); }
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'mrmak_config_test', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await rpc('config/read', { cwd: f.external, includeLayers: false });
    assert.equal(result.config.mcp_servers.mrmak_workspace.enabled, true);
    assert.equal(result.config.mcp_servers.mrmak_workspace.args[0], script);
    assert.equal(result.config.mcp_servers.mrmak_workspace.command, process.execPath);
    assert.equal(result.config.developer_instructions, 'Route Mr. Mik Hub pages through its Bridge.');
    assert.ok(!(await readdir(home)).includes('config.toml'));
    assert.deepEqual(await readdir(f.external), []);
  } finally {
    lines.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      // Wait for owned stdio handles as well as the process; on Windows an
      // exit event alone can race fixture removal while its pipes still close.
      const stopped = new Promise(resolve => child.once('close', resolve));
      let timer;
      await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await stopped;
    }
  }
});

test('New Codex Chat launches the real Windows terminal with a typed Bridge MCP array', { skip: process.platform !== 'win32' || !commandPath('codex')?.endsWith('.exe'), timeout: 20000 }, async () => {
  const f = await fixture(), home = path.join(f.repo, '.mrmak', 'isolated-codex-home');
  await mkdir(home, { recursive: true });
  let service, ownedSession, ownedProcess;
  try {
    service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui'), mcpOptions: { home: path.dirname(home), env: { CODEX_HOME: home } }, profileOptions: { root: path.join(f.repo, '.mrmak', 'test-accounts') } });
    const profile = await service.profiles.create('Bridge startup fixture');
    // Native startup/config parsing is under test, not a real account login.
    let preflight = false;
    service.sessions.verifyAccount = async (_session, context) => {
      assert.equal(context.profileId, profile.id); assert.equal(context.system, false);
      assert.equal(context.sharedHome, home); preflight = true;
    };
    const request = data => fetch(`${service.origin}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'codex', projectId: f.a.id, name: 'Bridge startup test', ...data }) });
    const missingAccount = await request({});
    assert.equal(missingAccount.status, 400); assert.match((await missingAccount.json()).error, /added Codex account/);
    const response = await request({ accountProfileId: profile.id, codexPermissions: 'ask' });
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const chat = await response.json();
    ownedSession = service.sessions.get(chat.id); ownedProcess = ownedSession.process;
    assert.equal(chat.accountProfileId, profile.id); assert.equal(preflight, true);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const screen = (await service.sessions.read(chat.id)).screen;
    assert.doesNotMatch(screen, /invalid type|expected a sequence|mcp_servers\.mrmak_workspace\.args/i);
    assert.equal(service.sessions.get(chat.id).status, 'running', `Codex exited at startup: ${screen.slice(0, 1200)}`);
  } finally {
    try {
      // This startup-only fixture owns the entire PTY process tree. Close its
      // children on failure too; inherited cwd handles can keep rmdir busy.
      if (ownedProcess && ownedSession.process === ownedProcess) {
        const stop = spawn('taskkill.exe', ['/PID', String(ownedProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { stop.once('close', resolve); stop.once('error', reject); });
      }
    } finally { await service?.close(); }
  }
});

test('quick Codex chat uses a card linked project, otherwise workspace planning, without launching a real CLI', async () => {
  const f = await fixture();
  const previousLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(f.repo, '.mrmak', 'test-appdata');
  let service;
  try {
    const blender = path.join(path.dirname(f.repo), 'blender');
    await mkdir(blender);
    const linked = await f.projects.saveRepository({ projectId: f.a.id, name: 'Blender', repositoryPath: blender });
    const workingCard = await f.projects.createCard({ projectId: f.a.id, repositoryId: linked.id, title: 'Models' });
    const planningCard = await f.projects.createCard({ projectId: f.a.id, title: 'Marketing' });
    service = await createService({ repo: f.repo, uiDir: path.join(f.repo, 'ui') });
    const created = [];
    service.sessions.create = async options => {
      created.push(options);
      const session = { id: `quick-chat-${created.length}` };
      service.sessions.items.set(session.id, service.sessions.make({ ...options, id: session.id, open: false, status: 'stopped', createdAt: new Date().toISOString() }));
      return session;
    };
    const request = (data) => fetch(`${service.origin}/api/chats/quick`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await request({ projectId: f.a.id, cardId: workingCard.id })).status, 201);
    assert.equal(created[0].agent, 'codex');
    assert.equal(created[0].name, 'Models');
    assert.equal(created[0].cardId, workingCard.id);
    assert.equal(created[0].repositoryId, linked.id);
    assert.equal(created[0].cwd, await realpath(blender));
    const routed = await service.sessions.prepareLaunch({ ...created[0], id: 'orientation-test' });
    assert.match(routed.instructions, /workspace "Exercise"/);
    assert.match(routed.instructions, /selected Hub card "Models"/);
    assert.match(routed.instructions, /linked working project "Blender"/);
    assert.doesNotMatch(routed.instructions, new RegExp(blender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    service.bridge.revoke('orientation-test');
    assert.equal((await request({ projectId: f.a.id, cardId: planningCard.id })).status, 201);
    assert.equal(created[1].cardId, planningCard.id);
    assert.equal(created[1].name, 'Marketing');
    assert.equal(created[1].repositoryId, null);
    assert.match(created[1].cwd, /workspace[\\/]planning/);
    assert.equal((await request({ projectId: f.a.id })).status, 201);
    assert.equal(created[2].cardId, null);
    assert.equal(created[2].name, 'Workspace planning');
    assert.equal(created[2].repositoryId, null);
    assert.equal((await request({ projectId: f.b.id, cardId: workingCard.id })).status, 400);
    await rename(blender, `${blender}-moved`);
    assert.equal((await request({ projectId: f.a.id, cardId: workingCard.id })).status, 400);
    assert.equal(created.length, 3);
  } finally {
    service?.sessions.items.clear();
    await service?.close();
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
  }
});
