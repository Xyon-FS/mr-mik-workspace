import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { relocatedSessionCwd } from '../session-location.mjs';
import { Sessions } from '../sessions.mjs';
import { randomUUID } from 'node:crypto';

test('History resume recovers the native ID at the old location then persists the new cwd without recreating the chat', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mrmik-history-location-'));
  const sessions = await new Sessions(repo, path.join(repo, 'state')).init();
  const old = path.join(repo, 'removed'), moved = path.join(repo, 'moved');
  await mkdir(moved);
  const nativeId = randomUUID(), id = randomUUID();
  const session = sessions.make({ id, agent: 'codex', projectId: 'project', repositoryId: 'primary', cwd: old, hasConversation: true, open: false });
  sessions.items.set(id, session);
  const observed = [];
  sessions.findNative = async value => { observed.push(['recover', value.cwd]); return { id: nativeId }; };
  const projects = { get: async () => ({ repositories: [{ id: 'primary' }] }), root: async () => moved };
  sessions.resolveLocation = value => relocatedSessionCwd(value, projects);
  sessions.nativeBoundary = async (value, resumed) => { observed.push(['boundary', value.cwd, resumed]); return null; };
  sessions.launch = async (value, resumed) => { observed.push(['launch', value.cwd, resumed]); };
  try {
    const base = { ...session, nativeId };
    for (const session of [{ ...base, projectId: null }, { ...base, repositoryId: null }, { ...base, repositoryId: undefined }]) assert.equal(await relocatedSessionCwd(session, projects), base.cwd);
    for (const agent of ['opencode', 'kimi', 'shell']) await assert.rejects(relocatedSessionCwd({ ...base, agent }, projects), /Native relocation/);
    await assert.rejects(relocatedSessionCwd({ ...base, agent: 'codex', repositoryId: 'deleted' }, projects), /registration/);
    await assert.rejects(relocatedSessionCwd({ ...base, agent: 'codex' }, { ...projects, root: async () => { throw new Error('Project folder unavailable'); } }), /unavailable/);
    const resumed = await sessions.resume(id);
    assert.equal(resumed.id, id);
    assert.equal(resumed.nativeId, nativeId);
    assert.equal(resumed.cwd, moved);
    assert.deepEqual(observed, [['recover', old], ['boundary', moved, nativeId], ['launch', moved, nativeId]]);
    const stored = JSON.parse(await readFile(path.join(repo, 'state', 'sessions.json'), 'utf8'));
    assert.equal(stored[0].cwd, moved);
    assert.equal(stored[0].nativeId, nativeId);
    session.process = { kill() {} };
    observed.length = 0;
    await sessions.resume(id);
    assert.deepEqual(observed, []);
    session.process = null;
  } finally { await sessions.close(); }
});
