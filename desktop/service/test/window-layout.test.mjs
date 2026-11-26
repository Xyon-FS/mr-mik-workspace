import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';

test('screen share defaults to 30/70, persists, rejects mixed invalid changes and only requests native layout explicitly', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-screen-share-'));
  await mkdir(path.join(repo, 'workspace')); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const events = [], options = { repo, uiDir: repo, native: event => events.push(event), mcpOptions: { home: path.join(repo, 'home'), env: {} } };
  let service = await createService(options);
  const settings = body => fetch(service.origin + '/api/settings', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const request = (body, authorized = true) => fetch(service.origin + '/api/window', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${service.token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal(service.chatWidthPercent, 30);
    for (const window of ['chats', 'workspace']) assert.equal((await request({ window, action: 'layout' })).status, 200);
    assert.deepEqual(events, ['chats', 'workspace'].map(window => ({ type: 'window', window, action: 'layout', value: false, chatWidthPercent: 30 })));
    assert.notEqual((await request({ window: 'external', action: 'layout' })).status, 200);
    assert.notEqual((await request({ window: 'chats', action: 'layout' }, false)).status, 200);
    assert.equal(events.length, 2);
    events.length = 0;
    for (const value of [null, '40', 19, 66, 25.5, {}, false]) {
      assert.notEqual((await settings({ chatWidthPercent: value, defaultBypass: true })).status, 200);
      assert.equal(service.chatWidthPercent, 30); assert.equal(events.filter(event => event.type === 'window').length, 0);
    }
    const response = await settings({ chatWidthPercent: 40 }); assert.equal(response.status, 200); assert.equal((await response.json()).chatWidthPercent, 40);
    assert.deepEqual(events.filter(event => event.type === 'window'), [{ type: 'window', action: 'layout', window: 'workspace', chatWidthPercent: 40 }]);
    const saved = JSON.parse(await readFile(path.join(repo, '.mrmak/settings.json'), 'utf8')); assert.equal(saved.defaultBypass, false); assert.equal(saved.chatWidthPercent, 40);
    await service.close(); service = await createService(options); assert.equal(service.chatWidthPercent, 40);
    await settings({ chatWidthPercent: 25 }); await service.close(); service = await createService(options); assert.equal(service.chatWidthPercent, 25, 'An explicit older 25/75 preference remains valid');
    assert.equal(service.sessions.items.size, 0);
  } finally { await service.close(); }
});
