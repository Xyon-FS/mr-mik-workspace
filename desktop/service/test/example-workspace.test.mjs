import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Projects } from '../projects.mjs';
import { addExampleWorkspace, exampleKey } from '../example-workspace.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { Sessions } from '../sessions.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-demo-')), repo = path.join(base, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  return { base, repo, projects, registry: async () => JSON.parse(await readFile(projects.workspacePath, 'utf8')) };
}

test('example is explicitly added, Hub-only, idempotent and preserves customized pages and unrelated state', async () => {
  const f = await fixture(); const personal = await f.projects.createCard({ title: 'Personal card' });
  const installed = await addExampleWorkspace(f.projects), project = await f.projects.get(installed.projectId);
  assert.deepEqual(project.repositories, []); assert.equal(project.available, true); assert.equal(project.repositoryPath, null);
  const cards = (await f.registry()).entities; assert.equal(cards.length, 5); assert.ok(cards.some(card => card.id === personal.id));
  assert.equal(cards.filter(card => card.sample).length, 4); assert.equal(cards.filter(card => card.pinned).length, 1);
  const first = cards.find(card => card.sample), file = path.join(f.repo, 'workspace', first.folder, 'index.html');
  await writeFile(file, 'My edited example'); await f.projects.save({ id: project.id, name: 'Renamed workshop', repositoryPath: '' });
  const again = await addExampleWorkspace(f.projects); assert.equal(again.existing, true); assert.equal(again.projectId, project.id);
  assert.equal(await readFile(file, 'utf8'), 'My edited example'); assert.equal((await f.registry()).entities.length, 5);
  assert.equal((await f.projects.get(project.id)).exampleKey, exampleKey);
  assert.deepEqual((await readdir(f.repo)).sort(), ['projects', 'workspace', '.mrmak', 'knowledge', 'processes'].sort());
  const snapshot = new WorkspaceSnapshot(f.repo, f.projects.stateDir, f.projects), exported = await snapshot.exportTo(f.base, installed.projectId);
  const other = await fixture(), target = new WorkspaceSnapshot(other.repo, other.projects.stateDir, other.projects);
  await target.importFrom(exported.path);
  assert.deepEqual((await other.projects.get(installed.projectId)).repositories, []);
  assert.equal((await other.projects.get(installed.projectId)).exampleKey, exampleKey);
  assert.equal((await addExampleWorkspace(other.projects)).existing, true);
  const sessions = await new Sessions(f.repo, f.projects.stateDir).init();
  try {
    const archive = new PortableArchive(f.repo, f.projects.stateDir, sessions, f.projects), file = await archive.exportTo(f.base, { chats: 'light' });
    assert.ok((await archive.preview(file.path)).manifest.files.some(entry => entry.name.endsWith('/espresso-cart.svg')));
  } finally { await sessions.close(); }
});
