import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, createService } from './fixtures.mjs';
import { inventory } from '../agents.mjs';

test('Kimi is absent from new agents and new Kimi chats cannot start', async t => {
  assert.ok(!inventory().some(agent => agent.id === 'kimi'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-retired-agents-'));
  const service = await createService({ repo: root, uiDir: root, mcpOptions: { home: path.join(root, 'home'), env: {} } });
  t.after(() => service.close());
  service.sessions.launch = async () => { throw new Error('Retired chats must never launch'); };
  await assert.rejects(service.sessions.create({ agent: 'kimi' }), /retired/);
  const id = randomUUID();
  const saved = service.sessions.make({ id, agent: 'kimi', nativeId: 'legacy-id', name: 'Saved fixture', cols: 90, rows: 32, cwd: root, status: 'stopped', open: false, hasConversation: true, createdAt: new Date().toISOString() });
  service.sessions.items.set(id, saved);
  await writeFile(path.join(root, '.mrmak', `screen-${id}.json`), JSON.stringify({ data: 'Preserved Kimi fixture history\r\n' }));
  const opened = await service.sessions.resume(id);
  assert.equal(opened.open, true); assert.equal(opened.status, 'stopped'); assert.equal(saved.process, null);
  assert.match((await service.sessions.read(id)).screen, /Preserved Kimi fixture history/);
  assert.throws(() => service.sessions.input(id, 'Do not send'), /stopped/);
});
