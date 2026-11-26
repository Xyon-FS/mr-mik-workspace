import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, readdir, symlink, rename } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { Projects } from '../projects.mjs';
import { CardRecycler, stageCardRemoval } from '../card-removal.mjs';
import { Workspace } from '../workspace.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { WorkspaceSnapshot } from '../workspace-snapshot.mjs';
import { Sessions } from '../sessions.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-card-removal-'));
  const repo = path.join(base, 'hub'), external = path.join(base, 'unity'), second = path.join(base, 'blender');
  for (const dir of [repo, external, second, path.join(repo, 'workspace')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(external, 'unchanged.txt'), 'external content');
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
  const projects = new Projects(repo, path.join(repo, '.mrmak'));
  const project = await projects.save({ name: 'Game', repositoryPath: external });
  const linked = await projects.saveRepository({ projectId: project.id, name: 'Blender', repositoryPath: second });
  const card = await projects.createCard({ projectId: project.id, repositoryId: linked.id, title: 'Models' });
  const other = await projects.createCard({ projectId: project.id, title: 'Overview' });
  const folder = path.join(repo, 'workspace', card.folder);
  await mkdir(folder); await writeFile(path.join(folder, 'page.html'), '<h1>Models</h1>');
  const recycled = [];
  projects.recycleCardFolder = async source => { const to = path.join(base, `recycled-${recycled.length}`); await rename(source, to); recycled.push(to); };
  const registry = async () => JSON.parse(await readFile(projects.workspacePath, 'utf8'));
  return { base, repo, external, projects, project, linked, card, other, folder, recycled, registry };
}

for (const [action, workspaceAction] of [['keep', 'archive'], ['archive', 'keep'], ['delete', 'delete']]) test(`unlink ${action} then remove workspace with ${workspaceAction} preserves data and scope`, async () => {
  const f = await fixture();
  await f.projects.removeRepository({ projectId: f.project.id, repositoryId: f.linked.id, cardAction: action, expectedCardIds: [f.card.id] });
  const cards = (await f.registry()).entities;
  assert.ok(cards.find(card => card.id === f.other.id));
  if (action === 'delete') { assert.equal(cards.length, 1); assert.equal(f.recycled.length, 1); }
  else { const card = cards.find(card => card.id === f.card.id); assert.equal(card.repositoryId, null); assert.equal(card.projectId, f.project.id); assert.equal(card.status, action === 'archive' ? 'archived' : 'active'); }
  assert.equal(await readFile(path.join(f.external, 'unchanged.txt'), 'utf8'), 'external content');
  const registry = await f.registry();
  registry.resources = [{ id: 'lesson', kind: 'knowledge', projectId: f.project.id, path: 'knowledge/projects/lesson.md' }];
  await writeFile(f.projects.workspacePath, JSON.stringify(registry));
  await writeFile(f.projects.inboxPath, JSON.stringify({ resources: [{ id: 'image', projectId: f.project.id, path: 'inbox/image.png' }] }));
  const otherFolder = path.join(f.repo, 'workspace', f.other.folder);
  await mkdir(otherFolder);
  await writeFile(path.join(otherFolder, 'page.html'), '<h1>Overview</h1>');
  if (workspaceAction === 'delete') {
    await assert.rejects(f.projects.remove(f.project.id, { cardAction: 'delete' }), /Review and confirm/);
    await assert.rejects(f.projects.remove(f.project.id, { cardAction: 'delete', expectedCardIds: [f.card.id] }), /changed/);
    assert.deepEqual((await f.registry()).entities.map(card => card.id), cards.map(card => card.id));
    assert.equal(await readFile(path.join(otherFolder, 'page.html'), 'utf8'), '<h1>Overview</h1>');
  }
  await f.projects.remove(f.project.id, { cardAction: workspaceAction, expectedCardIds: cards.map(card => card.id) });
  const after = await f.registry();
  assert.equal(after.resources[0].projectId, null);
  assert.equal(JSON.parse(await readFile(f.projects.inboxPath, 'utf8')).resources[0].projectId, null);
  if (workspaceAction === 'delete') {
    assert.equal(after.entities.length, 0);
    assert.equal(f.recycled.length, 2);
  }
  else for (const card of after.entities) { assert.equal(card.projectId, null); assert.equal(card.repositoryId, null); assert.equal(card.status, workspaceAction === 'archive' || card.id === f.card.id ? 'archived' : 'active'); }
  assert.equal(await readFile(path.join(f.external, 'unchanged.txt'), 'utf8'), 'external content');
});

test('shared, traversal, planning, junction and overlapping card folders are rejected without external writes', async () => {
  const f = await fixture(); const source = await f.registry();
  for (const folder of ['../unity', '_shared', 'planning/game', f.external, f.other.folder]) {
    const registry = structuredClone(source); registry.entities.find(card => card.id === f.card.id).folder = folder;
    await writeFile(f.projects.workspacePath, JSON.stringify(registry));
    await assert.rejects(f.projects.removeCard(f.card.id));
    assert.deepEqual(await readdir(f.external), ['unchanged.txt']);
  }
  await symlink(f.external, path.join(f.repo, 'workspace', 'outside'), 'junction');
  source.entities.find(card => card.id === f.card.id).folder = 'outside';
  await writeFile(f.projects.workspacePath, JSON.stringify(source));
  await assert.rejects(f.projects.removeCard(f.card.id), /ordinary|link/);
  await symlink(path.join(f.repo, 'workspace'), path.join(f.repo, 'workspace', 'internal-link'), 'junction');
  source.entities.find(card => card.id === f.card.id).folder = `internal-link/${f.card.folder}`;
  await writeFile(f.projects.workspacePath, JSON.stringify(source));
  await assert.rejects(f.projects.removeCard(f.card.id), /linked folder/);
  assert.deepEqual(await readdir(f.external), ['unchanged.txt']);
});

test('recycler requires matching native confirmation and does not confuse file events', async () => {
  const events = [], recycler = new CardRecycler(event => events.push(event));
  const first = recycler.recycle('fixture');
  recycler.receive({ type: 'card-recycle-result', requestId: 'unknown', recycled: true });
  assert.equal(recycler.pending.size, 1);
  recycler.receive({ type: 'card-recycle-result', requestId: events[0].requestId, recycled: true }); await first;
  const second = recycler.recycle('fixture'); recycler.close(); await assert.rejects(second, /closing/);
});

test('Hub transfer and content snapshots preserve archives, omit deleted cards and exclude recovery state', async () => {
  const f = await fixture(), sessions = await new Sessions(f.repo, f.projects.stateDir).init();
  try {
    const snapshots = new WorkspaceSnapshot(f.repo, f.projects.stateDir, f.projects);
    const initial = await snapshots.exportTo(f.base, f.project.id);
    await new Workspace(f.repo).update(f.other.id, { status: 'archived' });
    f.projects.recycleCardFolder = async () => { throw new Error('Retain isolated recovery bytes'); };
    const before = await readFile(f.projects.workspacePath, 'utf8');
    const stage = await stageCardRemoval(f.repo, f.projects.stateDir, await f.registry(), [f.card]);
    await stage.rollback();
    assert.equal(await readFile(f.projects.workspacePath, 'utf8'), before);
    assert.equal(await readFile(path.join(f.folder, 'page.html'), 'utf8'), '<h1>Models</h1>');
    assert.equal(f.recycled.length, 0);

    const result = await f.projects.removeCard(f.card.id);
    assert.equal(result.warnings.length, 1);
    assert.equal(await readFile(path.join(result.recoveryPath, 'content-0/page.html'), 'utf8'), '<h1>Models</h1>');
    assert.equal(JSON.parse(await readFile(path.join(result.recoveryPath, 'recovery.json'), 'utf8')).status, 'recovery-retained');
    const portable = new PortableArchive(f.repo, f.projects.stateDir, sessions, f.projects);
    const exported = await portable.exportTo(f.base, { chats: 'light' });
    const preview = await portable.preview(exported.path);
    assert.equal(preview.manifest.files.some(file => file.name.includes('card-recovery') || file.name.includes(f.card.folder)), false);
    const update = await snapshots.updatePreview(initial.path, f.project.id);
    assert.ok(update.removed.some(name => name.includes(f.card.folder)));
    await writeFile(path.join(initial.path, 'unrelated.txt'), 'Keep');
    await mkdir(path.join(initial.path, '.git'));
    await writeFile(path.join(initial.path, '.git/fixture'), 'Keep Git');
    const updated = await snapshots.update(initial.path, f.project.id);
    const relative = 'workspace/' + f.card.folder + '/page.html';
    assert.deepEqual(update.removed, [relative]);
    assert.equal(await readFile(path.join(updated.backup, relative), 'utf8'), '<h1>Models</h1>');
    assert.equal(await readFile(path.join(initial.path, 'unrelated.txt'), 'utf8'), 'Keep');
    assert.equal(await readFile(path.join(initial.path, '.git/fixture'), 'utf8'), 'Keep Git');
    const manifest = (await snapshots.load(initial.path)).manifest;
    assert.deepEqual(manifest.cards.map(card => [card.id, card.status]), [[f.other.id, 'archived']]);
    assert.equal(manifest.files.some(file => file.name.includes(f.card.folder) || file.name.includes('card-recovery')), false);
  } finally { await sessions.close(); }
});

test('HTTP deletion protects open chats and clears only card associations after confirmed recycling', async () => {
  const f = await fixture(); let service, reachedRecycle, recycleEvent;
  const recycleRequested = new Promise(resolve => { reachedRecycle = resolve; });
  service = await createService({ repo: f.repo, uiDir: f.repo, native: event => {
    if (event.type === 'recycle-file') { recycleEvent = event; reachedRecycle(); }
  } });
  try {
    const session = service.sessions.make({ id: 'saved', agent: 'codex', name: 'Saved', cwd: f.external, cardId: f.card.id, projectId: f.project.id, repositoryId: f.linked.id, open: true, nativeId: 'fixture-native-id', createdAt: new Date().toISOString() });
    service.sessions.items.set(session.id, session);
    const request = () => fetch(`${service.origin}/api/cards/delete`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: f.card.id, confirm: true }) });
    assert.equal((await request()).status, 409);
    session.open = false; const deletion = request(); await recycleRequested;
    const blocked = await fetch(`${service.origin}/api/workspace/export`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f.base, chats: 'light' }) });
    assert.equal(blocked.status, 409);
    await assert.rejects(service.sessions.prepareLaunch({}), /Wait for/);
    await f.projects.recycleCardFolder(recycleEvent.path);
    service.nativeMessage({ type: 'card-recycle-result', requestId: recycleEvent.requestId, recycled: true });
    const response = await deletion; assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(session.cardId, null); assert.equal(session.nativeId, 'fixture-native-id'); assert.equal(session.cwd, f.external); assert.equal(service.sessions.items.size, 1);
  } finally { await service.close(); }
});
