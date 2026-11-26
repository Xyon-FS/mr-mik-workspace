import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultChatShortcuts } from '../chat-shortcuts.mjs';
import { mkdtemp, createService } from './fixtures.mjs';

test('chat shortcut settings survive service restart and invalid updates preserve previous settings', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-shortcut-settings-')), repo = path.join(base, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const options = { repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'profiles') } };
  let service;
  const request = (route, data) => fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    service = await createService(options);
    const value = { ...defaultChatShortcuts, new: 'Ctrl+Alt+J' }, result = await request('/settings', { chatShortcuts: value, terminalFontSize: 15 });
    assert.equal(result.status, 200); assert.deepEqual((await result.json()).chatShortcuts, value);
    for (const chatShortcuts of [null, [], {}, { ...defaultChatShortcuts, extra: 'Ctrl+L' }, { ...defaultChatShortcuts, new: 'Ctrl+Shift+P' }, { ...defaultChatShortcuts, new: 'Ctrl+F' }, { ...defaultChatShortcuts, new: 'Alt+F4' }, { ...defaultChatShortcuts, new: 'Ctrl+Ctrl+J' }, { ...defaultChatShortcuts, new: 'Ctrl+Shift+' }, { ...defaultChatShortcuts, new: 'J' }, { ...defaultChatShortcuts, new: 42 }]) {
      const invalid = await request('/settings', { chatShortcuts, terminalFontSize: 22 });
      assert.equal(invalid.status, 400);
    }
    const previous = (await (await request('/bootstrap')).json()).settings; assert.deepEqual(previous.chatShortcuts, value); assert.equal(previous.terminalFontSize, 15);
    await service.close(); service = null;
    service = await createService(options);
    const reopened = (await (await request('/bootstrap')).json()).settings; assert.deepEqual(reopened.chatShortcuts, value); assert.equal(reopened.terminalFontSize, 15);
    assert.equal((await request('/settings', { chatShortcuts: defaultChatShortcuts })).status, 200);
    assert.deepEqual((await (await request('/bootstrap')).json()).settings.chatShortcuts, defaultChatShortcuts);
  } finally { await service?.close(); }
});
