import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../sessions.mjs';
import { NativeDeletion } from '../native-delete.mjs';

test('Claude native deletion requires a closed chat, a fresh plan and its exact name, then leaves the working folder alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-delete-test-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
  const hub = path.join(root, 'hub'), state = path.join(hub, '.mrmak');
  await mkdir(state, { recursive: true });
  const sessions = await new Sessions(hub, state).init();
  try {
    const id = '33333333-3333-4333-8333-333333333333';
    const chat = { id, nativeId: id, name: 'Delete test', agent: 'claude', cwd: hub, open: false, status: 'stopped', createdAt: new Date().toISOString() };
    sessions.items.set(id, sessions.make(chat)); await sessions.persist();
    const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', hub.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(path.join(folder, id), { recursive: true });
    const transcript = path.join(folder, `${id}.jsonl`);
    await writeFile(transcript, '{"type":"user"}\n');
    await writeFile(path.join(folder, id, 'result.txt'), 'sidecar');
    await writeFile(path.join(hub, 'sentinel.txt'), 'keep');
    await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id), { recursive: true });
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id, '1.json'), '{}');
    const other = path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', '44444444-4444-4444-8444-444444444444');
    await mkdir(other); await writeFile(path.join(other, '1.json'), 'keep');
    const deletion = new NativeDeletion(sessions, state);
    const plan = await deletion.plan(id);
    assert.equal(plan.files.length, 3);
    await assert.rejects(deletion.confirm(id, plan.token, 'wrong name'), /confirmation/);
    assert.ok(await stat(transcript));
    assert.deepEqual(await deletion.confirm(id, plan.token, 'Delete test'), { deleted: true, agent: 'claude' });
    assert.equal(await stat(transcript).catch(() => null), null);
    assert.equal(await stat(path.join(folder, id)).catch(() => null), null);
    assert.equal(await stat(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id)).catch(() => null), null);
    assert.equal(await readFile(path.join(other, '1.json'), 'utf8'), 'keep');
    assert.equal(sessions.list().length, 0);
    assert.equal(await readFile(path.join(hub, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await sessions.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
