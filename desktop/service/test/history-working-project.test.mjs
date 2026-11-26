import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';

test('History moves a closed planning conversation to a newly linked folder and back, preserving native identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-history-project-'));
  const repo = path.join(root, 'hub'), external = path.join(root, 'project'); await mkdir(repo); await mkdir(external);
  const service = await createService({ repo, uiDir: repo, restoreSessions: false, mcpOptions: { home: path.join(root, 'home'), env: {} }, profileOptions: { root: path.join(root, 'accounts') } });
  try {
    const project = await service.projects.save({ name: 'Initially planning' });
    const planning = path.join(repo, 'workspace/planning', project.id); await mkdir(planning, { recursive: true });
    const session = service.sessions.make({ id: randomUUID(), agent: 'codex', chatInterface: 'chat', projectId: project.id, repositoryId: null, cwd: planning, hasConversation: true, nativeId: randomUUID(), open: false, cardId: 'old-card' });
    service.sessions.items.set(session.id, session);
    const nativeId = session.nativeId;
    const linked = await service.projects.save({ id: project.id, name: project.name, repositoryPath: external });
    const request = async (body, expectedCode = 200) => {
      const response = await fetch(`${service.origin}/api/sessions/${session.id}/workingproject`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.status, expectedCode, data.error); return data;
    };
    const expected = () => ({ cwd: session.cwd, projectId: session.projectId, repositoryId: session.repositoryId });
    const original = expected();
    await request({ repositoryId: linked.repositories[0].id, expected: original });
    assert.equal(session.cwd.toLowerCase(), external.toLowerCase()); assert.equal(session.nativeId, nativeId); assert.equal(session.cardId, null);
    assert.equal(session.open, false); assert.equal(session.process, null);
    await request({ repositoryId: null, expected: original }, 400);
    assert.equal(session.cwd.toLowerCase(), external.toLowerCase());
    const disk = JSON.parse(await readFile(path.join(repo, '.mrmak/sessions.json'), 'utf8'));
    assert.equal(disk.find(item => item.id === session.id).cwd.toLowerCase(), external.toLowerCase());
    await request({ repositoryId: null, expected: expected() });
    assert.equal(session.cwd.toLowerCase(), planning.toLowerCase()); assert.equal(session.nativeId, nativeId);
    session.open = true;
    await request({ repositoryId: linked.repositories[0].id, expected: expected() }, 400);
    session.open = false;
    await request({ repositoryId: 'foreign-project', expected: expected() }, 400);
    session.agent = 'opencode'; await request({ repositoryId: linked.repositories[0].id, expected: expected() }, 400);
    assert.equal(session.cwd.toLowerCase(), planning.toLowerCase());
  } finally { await service.close(); }
});

test('CLI relocation verifies the old transcript before changing cwd and blocks competing resume', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-history-native-'));
  const sessions = await new Sessions(repo, path.join(repo, '.mrmak')).init();
  const old = path.join(repo, 'planning'), target = path.join(repo, 'target'), file = path.join(repo, 'native.jsonl');
  await mkdir(old); await mkdir(target); await writeFile(file, 'synthetic native transcript\n');
  try {
    for (const agent of ['codex', 'claude']) {
      const session = sessions.make({ id: randomUUID(), agent, projectId: 'workspace', repositoryId: null, cwd: old, nativeId: randomUUID(), hasConversation: true, open: false });
      sessions.items.set(session.id, session);
      let release; const gate = new Promise(resolve => { release = resolve; });
      sessions.nativeBoundary = async candidate => { assert.equal(candidate.cwd, old); await gate; return { file }; };
      const expected = { cwd: old, projectId: 'workspace', repositoryId: null };
      const change = sessions.setWorkingProject(session.id, { cwd: target, projectId: 'workspace', repositoryId: 'project', cardId: null }, expected);
      await assert.rejects(sessions.resume(session.id), /working project change/);
      release(); await change;
      assert.equal(session.repositoryId, 'project'); assert.equal(await readFile(file, 'utf8'), 'synthetic native transcript\n');
      const snapshot = { cwd: session.cwd, nativeId: session.nativeId, repositoryId: session.repositoryId };
      sessions.nativeBoundary = async () => { throw new Error('Synthetic missing transcript'); };
      await assert.rejects(sessions.setWorkingProject(session.id, { cwd: old, projectId: 'workspace', repositoryId: null, cardId: null }, { cwd: target, projectId: 'workspace', repositoryId: 'project' }), /missing transcript/);
      assert.deepEqual({ cwd: session.cwd, nativeId: session.nativeId, repositoryId: session.repositoryId }, snapshot);
      assert.equal(session.locationUpdating, false);
    }
  } finally { await sessions.close(); }
});
