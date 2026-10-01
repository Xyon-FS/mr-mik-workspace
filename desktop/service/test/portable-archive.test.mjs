import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { claudeTranscript, codexTranscript } from '../native-events.mjs';
import { terminalCommand } from '../agents.mjs';
import { codexCommandFixture } from './cli-fixture.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

test('Mak full export transfers native coordinator context and branches; light is History-only; reimport deduplicates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-mak-native-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(root, 'pc1');
    const file = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30', `rollout-fixture-${id}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: source.repo } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fixture context' }] } }) + '\n');
    const conversation = { id: projectId, threadId: id, projectId: null, title: 'Fixture Mak', parentId: null, at: '2026-09-30T00:00:00Z', effort: 'low', model: 'fixture-model', updatedAt: '2026-09-30T00:01:00Z' };
    await writeFile(path.join(source.stateDir, 'mak-conversations.json'), JSON.stringify({ conversations: [conversation], selected: { global: projectId } }));
    await writeFile(path.join(source.stateDir, 'settings.json'), JSON.stringify({ defaultWorkerEffort: 'ultra', defaultClaudeWorkerEffort: 'max', coordinatorEffort: 'low' }));
    const light = await source.archive.exportTo(root, { chats: 'light' });
    const full = await source.archive.exportTo(root, { chats: 'full' });
    process.env.CODEX_HOME = path.join(root, 'pc2');
    assert.equal((await target.archive.preview(light.path)).native.length, 0);
    const plan = await target.archive.preview(full.path); assert.equal(plan.native.length, 1); assert.ok(plan.native[0].name.startsWith('Mak'));
    await target.archive.importFrom(full.path, { restoreSettings: true }); await target.archive.importFrom(full.path);
    const importedSettings = JSON.parse(await readFile(path.join(target.stateDir, 'settings.json'), 'utf8'));
    assert.equal(importedSettings.defaultWorkerEffort, 'ultra'); assert.equal(importedSettings.defaultClaudeWorkerEffort, 'max'); assert.equal(importedSettings.coordinatorEffort, 'low');
    const records = JSON.parse(await readFile(path.join(target.stateDir, 'mak-conversations.json'), 'utf8'));
    assert.equal(records.conversations.length, 1); assert.equal(records.selected.global, projectId);
    assert.equal(records.conversations[0].effort, 'low'); assert.equal(records.conversations[0].model, 'fixture-model');
    assert.ok((await readFile(await codexTranscript(id), 'utf8')).includes('Fixture context'));
    assert.equal(target.sessions.list().length, 0);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('Mak text History travels in light/full archives and merges continuations by operation ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-mak-portable-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const first = { id: 'mak-first', text: 'Save lesson', result: 'Saved.', status: 'completed', at: '2026-09-30T00:00:00Z', scope: { projectId: null } };
  const second = { ...first, id: 'mak-second', text: 'Read lesson', at: '2026-09-30T00:01:00Z' };
  await mkdir(source.stateDir, { recursive: true });
  await writeFile(path.join(source.stateDir, 'mak-history.json'), JSON.stringify({ operations: [first], nativeThreadId: 'not-portable' }));
  const old = await source.archive.exportTo(root, { chats: 'light' });
  assert.ok((await target.archive.preview(old.path)).manifest.files.some(item => item.name === 'state/mak-history.json'));
  await target.archive.importFrom(old.path);
  await writeFile(path.join(source.stateDir, 'mak-history.json'), JSON.stringify({ operations: [first, second] }));
  const next = await source.archive.exportTo(root, { chats: 'full' });
  await target.archive.importFrom(next.path); await target.archive.importFrom(next.path);
  const imported = JSON.parse(await readFile(path.join(target.stateDir, 'mak-history.json'), 'utf8'));
  assert.deepEqual(imported.operations.map(item => item.id), ['mak-first', 'mak-second']);
  assert.ok(!JSON.stringify(imported).includes('nativeThreadId'));
});

test('Codex resume explicitly uses the relinked working folder', async t => {
  const binary = await codexCommandFixture(t);
  const command = terminalCommand('codex', { resumeId: id, cwd: 'C:\\Projects\\Game' });
  assert.equal(command.file, binary.file); assert.equal(command.args[0], binary.script);
  const index = command.args.indexOf('--cd');
  assert.ok(index >= 0);
  assert.equal(command.args[index + 1], 'C:\\Projects\\Game');
});

for (const agent of ['codex', 'claude']) test(`${agent}: two-computer import updates continuations, History/screens and backs up divergence without duplicates`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `mrmak-${agent}-incremental-`));
  const variable = agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const previous = process.env[variable];
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const useHome = name => { process.env[variable] = path.join(root, name); };
  try {
    useHome('pc1');
    const chat = { id, agent, nativeId: id, name: 'Original', cwd: source.repo, open: false, status: 'stopped', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', hasConversation: true };
    source.sessions.items.set(id, source.sessions.make(chat));
    const file = agent === 'codex' ? path.join(process.env[variable], 'sessions', '2026', '01', '01', `rollout-${id}.jsonl`) : await claudeTranscript(source.repo, id);
    await mkdir(path.dirname(file), { recursive: true });
    const first = JSON.stringify(agent === 'codex' ? { type: 'session_meta', payload: { id, cwd: source.repo } } : { type: 'user', uuid: id, message: { content: 'A' } }) + '\n';
    const continuation = first + '{"type":"assistant","message":{"content":"B"}}\n';
    await writeFile(file, first);
    await writeFile(path.join(source.stateDir, `screen-${id}.json`), JSON.stringify({ data: 'OLD SCREEN' }));
    const old = await source.archive.exportTo(root);
    await writeFile(file, continuation);
    Object.assign(source.sessions.get(id), { name: 'Continued', updatedAt: '2026-01-02T00:00:00Z', pinned: true, archived: true });
    await writeFile(path.join(source.stateDir, `screen-${id}.json`), JSON.stringify({ data: 'NEW SCREEN' }));
    if (agent === 'claude') {
      await mkdir(path.join(path.dirname(file), id, 'subagents'), { recursive: true });
      await writeFile(path.join(path.dirname(file), id, 'subagents', 'worker.jsonl'), '{"type":"assistant"}\n');
    }
    const newer = await source.archive.exportTo(root);
    useHome('pc2');
    await target.archive.importFrom(old.path);
    assert.equal(target.sessions.list().length, 1);
    // Different Mr. Mik IDs may refer to the same native conversation.
    const localId = '33333333-3333-4333-8333-333333333333';
    const original = target.sessions.get(id);
    original.id = localId;
    target.sessions.items.delete(id); target.sessions.items.set(localId, original);
    await writeFile(path.join(target.stateDir, `screen-${localId}.json`), JSON.stringify({ data: 'OLD SCREEN' }));
    const local = agent === 'codex' ? await codexTranscript(id) : await claudeTranscript(target.repo, id);
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'update');
    const result = await target.archive.importFrom(newer.path);
    assert.equal(result.nativeUpdated, 1); assert.equal(result.sessionsUpdated, 1);
    assert.equal(target.sessions.list().length, 1);
    assert.equal(target.sessions.list()[0].id, localId);
    assert.equal(target.sessions.list()[0].name, 'Continued');
    assert.equal(target.sessions.list()[0].pinned, true);
    assert.equal(target.sessions.list()[0].archived, true);
    assert.equal(target.sessions.list()[0].cwd, target.repo);
    assert.match(await readFile(path.join(target.stateDir, `screen-${localId}.json`), 'utf8'), /NEW SCREEN/);
    assert.equal(await readFile(local, 'utf8'), continuation);
    assert.equal(await readFile(path.join(result.backup, 'native', agent, `${id}.jsonl`), 'utf8'), first);
    assert.ok(JSON.parse(await readFile(path.join(result.backup, 'state', 'sessions.json'), 'utf8')).some(item => item.id === localId));
    if (agent === 'claude') assert.equal(await readFile(path.join(path.dirname(local), id, 'subagents', 'worker.jsonl'), 'utf8'), '{"type":"assistant"}\n');
    assert.equal((await target.archive.importFrom(newer.path)).nativeUpdated, 0);
    assert.equal((await target.archive.preview(old.path)).native[0].status, 'local-newer');
    await target.archive.importFrom(old.path);
    assert.equal(target.sessions.get(localId).name, 'Continued');
    assert.equal(await readFile(local, 'utf8'), continuation);
    const divergent = first + '{"type":"assistant","message":{"content":"LOCAL BRANCH"}}\n';
    await writeFile(local, divergent);
    target.sessions.get(localId).name = 'Local branch name';
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'conflict');
    await target.archive.importFrom(newer.path);
    assert.equal(await readFile(local, 'utf8'), divergent);
    assert.equal(target.sessions.get(localId).name, 'Local branch name');
    const replaced = await target.archive.importFrom(newer.path, { replaceNative: [`${agent}:${id}`] });
    assert.equal(await readFile(local, 'utf8'), continuation);
    assert.equal(target.sessions.get(localId).name, 'Continued');
    assert.equal(await readFile(path.join(replaced.backup, 'native', agent, `${id}.jsonl`), 'utf8'), divergent);
    await writeFile(local, first.slice(0, -1));
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'conflict', 'an incomplete final record is not ancestry');
    await writeFile(local, first);
    const duplicate = agent === 'codex' ? path.join(process.env[variable], 'sessions', 'duplicate', `rollout-${id}.jsonl`) : path.join(process.env[variable], 'projects', 'duplicate', `${id}.jsonl`);
    await mkdir(path.dirname(duplicate), { recursive: true }); await writeFile(duplicate, first);
    await assert.rejects(target.archive.preview(newer.path), /Multiple native/);
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});

async function hub(root, name) {
  const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
  for (const folder of ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [], resources: [] }));
  await writeFile(path.join(repo, 'projects', 'registry.json'), JSON.stringify({ projects: [] }));
  const sessions = await new Sessions(repo, stateDir).init();
  return { repo, stateDir, sessions, archive: new PortableArchive(repo, stateDir, sessions, null) };
}

test('portable planning chats relocate inside the imported Hub without changing linked project folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-planning-export-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const oldLocal = path.join(root, 'old-local-chat');
  const mapped = { [projectId]: { primary: path.join(root, 'linked-project') } };
  const manifest = { sourceHub: source.repo };
  const expected = path.join(target.repo, 'workspace', 'planning', projectId);
  assert.equal(target.archive.relocatedCwd({ projectId, repositoryId: null, cwd: oldLocal }, manifest, mapped), expected);
  assert.equal(target.archive.relocatedCwd({ projectId, repositoryId: null, cwd: path.join(source.repo, 'workspace', 'planning', projectId) }, manifest, mapped), expected);
  assert.equal(target.archive.relocatedCwd({ projectId: null, repositoryId: null, cwd: source.repo }, manifest, mapped), target.repo);
});

test('export and import keep a promoted linked project without recreating the removed primary link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-unlinked-export-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const oldProject = path.join(root, 'blender-old'), newProject = path.join(root, 'blender-new');
    await mkdir(oldProject); await mkdir(newProject);
    await writeFile(path.join(source.repo, 'projects', 'registry.json'), JSON.stringify({ projects: [{ id: projectId, name: 'Game', repositories: [{ id: 'blender', name: 'Blender' }] }] }));
    await writeFile(path.join(source.stateDir, 'project-locations.json'), JSON.stringify({ [projectId]: { repositoryPath: oldProject, repositories: { blender: oldProject } } }));
    const exported = await source.archive.exportTo(root, { chats: 'light' });
    const preview = await target.archive.preview(exported.path);
    assert.deepEqual(Object.keys(preview.manifest.projectPaths[projectId]), ['blender']);
    await target.archive.importFrom(exported.path, { relinks: { [projectId]: { blender: newProject } } });
    assert.deepEqual(JSON.parse(await readFile(path.join(target.repo, 'projects', 'registry.json'), 'utf8')).projects[0].repositories, [{ id: 'blender', name: 'Blender' }]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(target.stateDir, 'project-locations.json'), 'utf8'))[projectId].repositories), ['blender']);
    assert.equal((await target.archive.preview(exported.path)).suggestedRelinks[projectId].blender, await realpath(newProject));
    const thirdProject = path.join(root, 'blender-third'); await mkdir(thirdProject);
    await target.archive.importFrom(exported.path, { relinks: { [projectId]: { blender: thirdProject } } });
    assert.equal(JSON.parse(await readFile(path.join(target.stateDir, 'project-locations.json'), 'utf8'))[projectId].repositories.blender, await realpath(thirdProject));
  } finally { await source.sessions.close(); await target.sessions.close(); }
});

test('portable full export imports Hub files, relinks projects and restores a Codex transcript without touching linked folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-portable-'));
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-home'); process.env.CODEX_HOME = codexHome;
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const oldProject = path.join(root, 'old-project'), newProject = path.join(root, 'new-project');
    await mkdir(oldProject); await mkdir(newProject);
    await writeFile(path.join(newProject, 'sentinel.txt'), 'never edit linked projects');
    await writeFile(path.join(source.repo, 'knowledge', 'lesson.md'), 'portable lesson');
    await writeFile(path.join(source.repo, 'processes', 'release.md'), '# Release steps');
    await writeFile(path.join(source.repo, 'inbox', 'reference.png'), 'fixture-image');
    await mkdir(path.join(source.repo, '.agents', 'skills', 'handoff'), { recursive: true });
    await mkdir(path.join(source.repo, '.claude', 'skills', 'handoff'), { recursive: true });
    await writeFile(path.join(source.repo, '.agents', 'skills', 'handoff', 'SKILL.md'), '# Codex handoff');
    await writeFile(path.join(source.repo, '.claude', 'skills', 'handoff', 'SKILL.md'), '# Claude handoff');
    await writeFile(path.join(source.repo, 'projects', 'skill-scopes.json'), JSON.stringify({ skills: { handoff: { global: true, projects: { [projectId]: false } } }, claudeSkills: { handoff: { global: false, projects: { [projectId]: true } } } }));
    await writeFile(path.join(source.repo, '.env'), 'PRIVATE_KEY=must-not-export');
    await writeFile(path.join(source.repo, 'projects', 'registry.json'), JSON.stringify({ projects: [{ id: projectId, name: 'Game', repositories: [{ id: 'primary', name: 'Unity' }] }] }));
    await writeFile(path.join(source.repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [{ id: 'card', title: 'Gameplay', folder: 'gameplay', projectId, repositoryId: 'primary', pinned: true, steps: [] }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', title: 'Lesson', projectId }] }));
    await writeFile(path.join(source.stateDir, 'inbox.json'), JSON.stringify({ resources: [{ id: 'reference', kind: 'inbox', path: 'inbox/reference.png', title: 'Reference', projectId }] }));
    await writeFile(path.join(source.stateDir, 'settings.json'), JSON.stringify({ defaultAgent: 'claude', defaultBypass: true, terminalAppearance: 'original', accentTheme: 'blue', selectedProjectId: projectId, selectedId: id, workspaceRoute: '#/old' }));
    await writeFile(path.join(source.stateDir, 'project-locations.json'), JSON.stringify({ [projectId]: { repositoryPath: oldProject, repositories: { primary: oldProject } } }));
    const chat = { id, agent: 'codex', nativeId: id, name: 'Unity chat', cwd: oldProject, projectId, repositoryId: 'primary', open: false, status: 'stopped', createdAt: new Date().toISOString() };
    source.sessions.items.set(id, source.sessions.make(chat)); await source.sessions.persist();
    const transcript = path.join(codexHome, 'sessions', '2026', '09', '28', `rollout-${id}.jsonl`);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: oldProject } }) + '\n');
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    const preview = await target.archive.preview(exported.path);
    assert.equal(preview.native[0].status, 'identical');
    assert.ok(!preview.manifest.files.some(file => file.name.includes('.env')));
    const imported = await target.archive.importFrom(exported.path, { relinks: { [projectId]: { primary: newProject } } });
    assert.equal(imported.nativeSkipped, 1);
    assert.equal(target.sessions.list()[0].cwd, await realpath(newProject));
    assert.equal(await readFile(path.join(target.repo, 'knowledge', 'lesson.md'), 'utf8'), 'portable lesson');
    assert.equal(await readFile(path.join(target.repo, 'processes', 'release.md'), 'utf8'), '# Release steps');
    assert.equal(await readFile(path.join(target.repo, 'inbox', 'reference.png'), 'utf8'), 'fixture-image');
    assert.equal(JSON.parse(await readFile(path.join(target.repo, 'workspace', 'workspace.json'), 'utf8')).entities[0].pinned, true);
    assert.equal(JSON.parse(await readFile(path.join(target.stateDir, 'inbox.json'), 'utf8')).resources[0].projectId, projectId);
    assert.equal((await stat(path.join(target.stateDir, 'settings.json')).catch(() => null)), null);
    const restored = await target.archive.importFrom(exported.path, { restoreSettings: true });
    assert.equal(restored.restoredSettings.defaultBypass, true);
    const preferences = JSON.parse(await readFile(path.join(target.stateDir, 'settings.json'), 'utf8'));
    assert.equal(preferences.defaultAgent, 'claude');
    assert.equal(preferences.accentTheme, 'blue');
    assert.equal(preferences.selectedProjectId, projectId);
    assert.equal(preferences.selectedId, undefined);
    assert.equal(preferences.workspaceRoute, undefined);
    assert.equal(await readFile(path.join(target.repo, '.agents', 'skills', 'handoff', 'SKILL.md'), 'utf8'), '# Codex handoff');
    assert.equal(await readFile(path.join(target.repo, '.claude', 'skills', 'handoff', 'SKILL.md'), 'utf8'), '# Claude handoff');
    const importedSkillScopes = JSON.parse(await readFile(path.join(target.repo, 'projects', 'skill-scopes.json'), 'utf8'));
    assert.equal(importedSkillScopes.skills.handoff.global, true);
    assert.equal(importedSkillScopes.skills.handoff.projects[projectId], false);
    assert.equal(importedSkillScopes.claudeSkills.handoff.projects[projectId], true);
    assert.equal((await stat(path.join(target.repo, '.env')).catch(() => null)), null);
    assert.equal(await readFile(path.join(newProject, 'sentinel.txt'), 'utf8'), 'never edit linked projects');
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('full export includes Claude session sidecars; light export keeps only Mr. Mik History', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-portable-'));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const chat = { id, agent: 'claude', nativeId: id, name: 'Research', cwd: source.repo, open: false, status: 'stopped', createdAt: new Date().toISOString() };
    source.sessions.items.set(id, source.sessions.make(chat)); await source.sessions.persist();
    const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', source.repo.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(path.join(folder, id, 'tool-results'), { recursive: true });
    await writeFile(path.join(folder, `${id}.jsonl`), '{"type":"user"}\n');
    await writeFile(path.join(folder, id, 'tool-results', 'result.txt'), 'generated result');
    await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id), { recursive: true });
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id, '1.json'), '{"status":"pending"}');
    await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id), { recursive: true });
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id, 'snapshot.txt'), 'checkpoint');
    const full = await source.archive.exportTo(root, { chats: 'full' });
    assert.ok((await source.archive.preview(full.path)).manifest.files.some(file => file.name.endsWith('tool-results/result.txt')));
    assert.ok((await source.archive.preview(full.path)).manifest.files.some(file => file.name.includes('_mrmak-state/tasks/')));
    const pc1 = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'pc2');
    await target.archive.importFrom(full.path);
    assert.equal(await readFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id, '1.json'), 'utf8'), '{"status":"pending"}');
    assert.equal(await readFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id, 'snapshot.txt'), 'utf8'), 'checkpoint');
    // Relinking the Hub again keeps the existing native transcript at its source.
    const next = await hub(root, 'next');
    try {
      await next.archive.importFrom(full.path);
      assert.equal(next.sessions.list()[0].cwd, next.repo);
      assert.equal(await stat(await claudeTranscript(next.repo, id)).catch(() => null), null);
      assert.ok(await stat(await claudeTranscript(next.repo, id, { search: true })));
      assert.equal((await next.archive.exportTo(root, { chats: 'full' })).chats, 1);
    } finally { await next.sessions.close(); }
    process.env.CLAUDE_CONFIG_DIR = pc1;
    const light = await source.archive.exportTo(root, { chats: 'light' });
    const preview = await target.archive.preview(light.path);
    assert.equal(preview.native.length, 0);
    assert.equal(preview.manifest.chats, 'light');
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
  }
});

test('import conflict choice updates matching cards and resource associations without dropping local entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-merge-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const file = 'workspace/workspace.json';
    await writeFile(path.join(source.repo, file), JSON.stringify({ entities: [{ id: 'shared', title: 'Imported card', pinned: true }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', projectId }] }));
    await writeFile(path.join(target.repo, file), JSON.stringify({ entities: [{ id: 'shared', title: 'Local card', pinned: false }, { id: 'local', title: 'Keep me' }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', projectId: null }] }));
    const archive = await source.archive.exportTo(root, { chats: 'light' });
    await target.archive.importFrom(archive.path);
    let cards = JSON.parse(await readFile(path.join(target.repo, file), 'utf8'));
    assert.equal(cards.entities.find(item => item.id === 'shared').title, 'Local card');
    assert.equal(cards.resources[0].projectId, null);
    await target.archive.importFrom(archive.path, { replaceHub: [file] });
    cards = JSON.parse(await readFile(path.join(target.repo, file), 'utf8'));
    assert.equal(cards.entities.find(item => item.id === 'shared').pinned, true);
    assert.equal(cards.entities.find(item => item.id === 'local').title, 'Keep me');
    assert.equal(cards.resources[0].projectId, projectId);
  } finally { await source.sessions.close(); await target.sessions.close(); }
});
