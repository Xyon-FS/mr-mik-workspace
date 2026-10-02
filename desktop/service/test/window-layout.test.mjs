import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server.mjs';

test('layout requests target only app windows and require local authorization; no native window is moved by the test', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-layout-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const events = [];
  const service = await createService({ repo, uiDir: repo, native: event => events.push(event), mcpOptions: { home: path.join(repo, 'fixture-home'), env: {} } });
  const request = (body, authorized = true) => fetch(service.origin + '/api/window', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${service.token}` } : {}) }, body: JSON.stringify(body) });
  try {
    for (const window of ['chats', 'workspace']) assert.equal((await request({ window, action: 'layout' })).status, 200);
    assert.deepEqual(events, ['chats', 'workspace'].map(window => ({ type: 'window', window, action: 'layout', value: false })));
    assert.notEqual((await request({ window: 'external', action: 'layout' })).status, 200);
    assert.notEqual((await request({ window: 'chats', action: 'layout' }, false)).status, 200);
    assert.equal(events.length, 2);
    assert.equal(service.sessions.items.size, 0);
  } finally { await service.close(); }
});
