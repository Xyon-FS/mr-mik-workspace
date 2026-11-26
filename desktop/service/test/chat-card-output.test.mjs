import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, realpath, symlink, readdir } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { Projects } from '../projects.mjs';
import { resolveChatCardOutput, saveChatCardOutput } from '../chat-card-output.mjs';
import { messageResults } from '../chat-results.mjs';

async function fixture(project = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-card-output-')), repo = path.join(root, 'hub'), external = path.join(root, 'project');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(external);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const projects = new Projects(repo, path.join(root, 'state'));
  const selected = project ? await projects.save({ name: 'Output fixture', repositoryPath: external }) : null;
  const session = { id: 'fixture-session', agent: 'claude', chatInterface: 'chat', projectId: selected?.id || null, cwd: project ? external : repo };
  const item = { id: 'response', type: 'agentMessage', text: '# Completed concept\n\nA saved response.', status: 'completed' };
  const runtime = { runtimeId: 'fixture-runtime', items: new Map([[item.id, item]]), historyItems: new Map(), previewPaths: new Set() };
  const registry = async () => JSON.parse(await readFile(projects.workspacePath, 'utf8'));
  const context = { repo, projects, session, runtime };
  return { ...context, root, external, selected, item, registry, resolve: input => resolveChatCardOutput({ ...context, input }), save: (output, input) => saveChatCardOutput({ projects, session, output, input }) };
}

test('output linking keeps project files live, records provenance and avoids duplicates', async () => {
  const f = await fixture(), file = path.join(f.external, 'concept.html'); await writeFile(file, '<html>one</html>');
  const other = await f.projects.save({ name: 'Other', repositoryPath: await mkdir(path.join(f.root, 'other')).then(() => path.join(f.root, 'other')) });
  const foreign = await f.projects.createCard({ projectId: other.id, title: 'Foreign' });
  await writeFile(path.join(f.external, '.env'), 'PRIVATE=fixture');
  await writeFile(path.join(f.root, 'outside.md'), '# Outside');
  await mkdir(path.join(f.root, 'outside')); await writeFile(path.join(f.root, 'outside/concept.md'), '# Outside');
  await symlink(path.join(f.root, 'outside'), path.join(f.external, 'escape'), 'junction');
  for (const href of ['.env', '../outside.md', 'escape/concept.md', 'https://example.test/concept.html', 'javascript:alert(1)']) await assert.rejects(f.resolve({ itemId: 'response', href }));
  await assert.rejects(f.resolve({ itemId: 'missing', message: true }));
  await assert.rejects(f.resolve({ itemId: 'response', message: true, runtimeId: 'old' }), /changed/);
  const note = await f.resolve({ itemId: 'response', message: true });
  await assert.rejects(f.save(note, { cardId: foreign.id, title: 'No', revision: note.revision }), /project/);
  await assert.rejects(f.save(note, { cardTitle: 'No', title: 'No', revision: 'obsolete' }), /changed/);
  assert.equal((await f.registry()).entities.length, 1);
  assert.deepEqual(await readdir(path.join(f.repo, 'workspace')), ['workspace.json']);
  const output = await f.resolve({ itemId: 'response', href: 'concept.html' });
  const saved = await f.save(output, { title: 'Concept', cardTitle: 'Design', revision: output.revision });
  const card = (await f.registry()).entities.find(item => item.id === saved.cardId);
  assert.equal(card.id, saved.cardId); assert.deepEqual(card.steps, []); assert.equal(card.artifacts.length, 1);
  assert.equal(card.artifacts[0].source.itemId, 'response'); assert.equal(card.artifacts[0].source.mode, 'live');
  assert.equal(await f.projects.artifactLocation(f.selected.id, card.id, 'concept.html', 'primary'), await realpath(file));
  assert.equal((await f.save(output, { cardId: card.id, title: 'Again', revision: output.revision })).duplicate, true);
  await writeFile(file, '<html>two</html>'); assert.equal(await readFile(await f.projects.artifactLocation(f.selected.id, card.id, 'concept.html'), 'utf8'), '<html>two</html>');
  assert.equal((await f.registry()).entities.find(item => item.id === saved.cardId).artifacts.length, 1);
  assert.doesNotMatch(await readFile(f.projects.workspacePath, 'utf8'), /repositoryPath|C:\\\\Users/);
});

test('HTTP output actions require the same runtime and do not start an agent', async () => {
  const f = await fixture(false), service = await createService({ repo: f.repo, uiDir: path.resolve('dist'), mcpOptions: { home: path.join(f.root, 'home'), env: {} }, profileOptions: { root: path.join(f.root, 'accounts') } });
  try {
    service.sessions.items.set(f.session.id, { ...f.session, graphical: f.runtime });
    const call = async data => {
      const response = await fetch(`${service.origin}/api/sessions/${f.session.id}/output`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, result: await response.json() };
    };
    f.item.text = "First output\n```html\n<div>First</div>\n```\nSecond output\n```javascript\nconst sample = 2;\n```";
    const selected = messageResults(f.item)[1];
    const selection = { itemId: f.item.id, resultIndex: selected.index, resultRevision: selected.revision };
    const described = await call({ ...selection, action: 'describe' });
    assert.equal(described.status, 200);
    const input = { ...selection, action: 'save', title: 'Selected code', cardTitle: 'Card', revision: described.result.revision, runtimeId: described.result.runtimeId, requestId: 'repeat-save-request-123456789' };
    assert.equal((await call({ ...input, runtimeId: 'obsolete' })).status, 400);
    const saved = await call(input);
    assert.equal(saved.status, 201);
    const retried = await call(input);
    assert.equal(retried.status, 201);
    assert.equal(retried.result.cardId, saved.result.cardId); assert.equal(retried.result.duplicate, true);
    const { entities } = await f.registry();
    assert.equal(entities.length, 1);
    const card = entities[0];
    assert.equal(card.steps.length, 1);
    const text = await readFile(path.join(f.repo, 'workspace', card.folder, card.steps[0].path), 'utf8');
    assert.match(text, /const sample = 2/); assert.doesNotMatch(text, /First|<div>/);
    f.item.text += '\nChanged';
    const stale = await call({ ...selection, action: 'describe' });
    assert.equal(stale.status, 400); assert.match(stale.result.error, /output changed/i);
    const invalid = await call({ ...selection, resultIndex: -1, action: 'describe' });
    assert.equal(invalid.status, 400); assert.match(invalid.result.error, /recorded output/i);
  } finally { service.sessions.items.delete(f.session.id); await service.close(); }
});

test('a scope change while saving rolls back the note and new card', async () => {
  const f = await fixture(false), output = await f.resolve({ itemId: 'response', message: true });
  let checks = 0;
  await assert.rejects(saveChatCardOutput({ projects: f.projects, session: f.session, output, input: { title: 'Note', cardTitle: 'Design', revision: output.revision }, assertCurrent: () => { if (++checks > 1) throw new Error('The conversation changed.'); } }), /conversation changed/);
  assert.equal((await f.registry()).entities.length, 0);
  assert.deepEqual(await readdir(path.join(f.repo, 'workspace')), ['workspace.json']);
});
