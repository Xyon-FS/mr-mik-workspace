import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink, realpath } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { Projects } from '../projects.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-snapshot-'));
  const make = async name => {
    const repo = path.join(base, name), state = path.join(repo, '.mrmak');
    for (const folder of ['workspace/_shared', 'knowledge', 'processes', 'inbox', 'projects', '.agents/skills/example', '.claude/skills/example', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
    await writeFile(path.join(repo, 'workspace/_shared/report.css'), 'body { color: white }');
    for (const prefix of ['.agents', '.claude']) await writeFile(path.join(repo, prefix, 'skills/example/SKILL.md'), '---\nname: example\ndescription: fixture\n---\nDo fixture work.');
    const projects = new Projects(repo, state);
    return { repo, state, projects, snapshots: new WorkspaceSnapshot(repo, state, projects) };
  };
  const source = await make('source'), destination = await make('destination');
  const linked = path.join(base, 'external'); await mkdir(linked); await writeFile(path.join(linked, 'source.txt'), 'Never copy this');
  const project = await source.projects.save({ name: 'Game X', repositoryPath: linked });
  const card = await source.projects.createCard({ title: 'Unity', projectId: project.id, repositoryId: 'primary' });
  await mkdir(path.join(source.repo, 'workspace', card.folder), { recursive: true });
  await writeFile(path.join(source.repo, 'workspace', card.folder, 'index.html'), '<h1>Card</h1>');
  const resource = await source.projects.createResource({ kind: 'knowledge', projectId: project.id, title: 'Lesson', text: 'Fixture lesson' });
  await writeFile(path.join(source.repo, 'inbox/image.png'), 'fixture-image');
  await source.projects.assignResource({ kind: 'inbox', path: 'inbox/image.png', projectId: project.id });
  await source.projects.setHubSkillScope({ id: 'example', projectId: project.id, scope: 'project', enabled: true });
  const exported = await source.snapshots.exportTo(base, project.id);
  t.diagnostic('Isolated fixture; no user Hub or CLI profile is used.');
  return { base, source, destination, linked, project, card, resource, exported };
}

test('workspace snapshot excludes native state and external folders; import relinks and preserves skill scopes without copying global flags', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(f.exported.path, 'mik-workspace.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(manifest), /repositoryPath|nativeId|token|sessions\.json/);
  assert.equal(manifest.project.id, f.project.id);
  const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.appVersion, version);
  assert.ok(manifest.files.some(item => item.name === 'inbox/image.png'));
  assert.ok(manifest.files.some(item => item.name === 'skills/codex/example/SKILL.md'));
  await f.destination.snapshots.importFrom(f.exported.path);
  assert.equal((await f.destination.projects.get(f.project.id)).available, false);
  await f.destination.snapshots.importFrom(f.exported.path, { replaceMetadata: true });
  assert.equal((await f.destination.projects.metadata()).projects.length, 1);
  const relative = `workspace/${f.card.folder}/index.html`, local = path.join(f.destination.repo, relative);
  await writeFile(local, 'Local content');
  assert.equal((await f.destination.snapshots.preview(f.exported.path)).files.find(item => item.name === relative).status, 'conflict');
  await assert.rejects(f.destination.snapshots.importFrom(f.exported.path), /Resolve all file conflicts/);
  assert.equal(await readFile(local, 'utf8'), 'Local content');
  const result = await f.destination.snapshots.importFrom(f.exported.path, { replaceFiles: [relative], replaceMetadata: true, relinks: { primary: f.linked } });
  assert.equal(await readFile(path.join(result.backup, relative), 'utf8'), 'Local content');
  assert.equal(await readFile(local, 'utf8'), '<h1>Card</h1>');
  assert.equal((await f.destination.projects.get(f.project.id)).repositoryPath, await realpath(f.linked));
  assert.equal((await f.destination.projects.hubSkills(f.project.id))[0].effective, true);
  assert.equal((await f.destination.projects.hubSkills(null))[0].global, false);
  assert.equal((await f.destination.projects.resources('inbox', f.project.id, 'project')).length, 1);
  assert.deepEqual(await readdir(f.linked), ['source.txt']);
});

test('snapshot rejects checksum tampering, traversal and content links before modifying the Hub', async t => {
  const f = await fixture(t), file = path.join(f.exported.path, 'mik-workspace.json');
  await writeFile(f.destination.projects.workspacePath, JSON.stringify({ entities: [{ id: f.card.id, folder: f.card.folder, projectId: 'other-workspace' }], resources: [] }));
  await assert.rejects(f.destination.snapshots.preview(f.exported.path), /another workspace/);
  await writeFile(f.destination.projects.workspacePath, JSON.stringify({ entities: [], resources: [] }));
  await assert.rejects(f.destination.snapshots.importFrom(f.exported.path, { relinks: { primary: f.destination.repo } }), /outside the Hub/);
  assert.equal((await f.destination.projects.metadata()).projects.length, 0);
  const original = await readFile(file, 'utf8'), manifest = JSON.parse(original);
  manifest.files[0].name = '../escape.txt'; await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(f.destination.snapshots.preview(f.exported.path), /Invalid|unrelated/);
  await writeFile(file, original);
  await writeFile(path.join(f.exported.path, manifest.files[1].name), 'Modified');
  await assert.rejects(f.destination.snapshots.preview(f.exported.path), /changed/);
  assert.equal((await f.destination.projects.metadata()).projects.length, 0);
  const junction = path.join(f.source.repo, 'workspace', f.card.folder, 'external-link');
  await symlink(f.linked, junction, 'junction');
  await assert.rejects(f.source.snapshots.exportTo(f.base, f.project.id), /links/);
});

test('snapshot rollback restores replaced bytes and removes only its newly created file on a transfer failure', async t => {
  const f = await fixture(t);
  const oldFile = path.join(f.destination.repo, 'inbox/existing.txt');
  await writeFile(oldFile, 'Original local bytes');
  const incoming = path.join(f.base, 'incoming.txt'); await writeFile(incoming, 'Incoming bytes');
  await assert.rejects(f.destination.snapshots.commit(f.destination.repo, [
    { relative: 'inbox/existing.txt', source: incoming },
    { relative: 'inbox/new.txt', source: incoming, sha256: '0'.repeat(64) },
  ], path.join(f.destination.state, 'snapshot-backups')), /rolled back/);
  assert.equal(await readFile(oldFile, 'utf8'), 'Original local bytes');
  await assert.rejects(readFile(path.join(f.destination.repo, 'inbox/new.txt')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.linked), ['source.txt']);
});
