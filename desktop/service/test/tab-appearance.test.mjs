import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { Sessions } from '../sessions.mjs';
import { decorateTerminal, roleColors } from '../../../src/desktop/terminalAppearance.ts';
import { orderedChats } from '../../../src/desktop/chatOrder.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function fixture() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'tab-appearance-'));
  const sessions = await new Sessions(repo, path.join(repo, '.mrmak')).init();
  for (const [id, pinned, open] of [['pin-a', true, true], ['pin-b', true, true], ['first', false, true], ['saved', false, false], ['last', false, true]]) {
    sessions.items.set(id, sessions.make({ id, name: id, agent: 'codex', pinned, open, status: 'stopped', createdAt: '2026-09-12', cols: 80, rows: 25 }));
  }
  return { repo, sessions };
}

test('tab reordering respects pin boundaries, closed history positions and frontend shortcut order', async () => {
  const { sessions, repo } = await fixture();
  let reopened, service;
  try {
    await sessions.reorder('last', 'first', 'before');
    assert.deepEqual(sessions.active().map(x => x.id), ['pin-a', 'pin-b', 'last', 'first']);
    assert.deepEqual(orderedChats([...sessions.items.values()]).map(x => x.id), ['pin-a', 'pin-b', 'last', 'first']);
    await sessions.reorder('pin-b', 'pin-a', 'before');
    assert.deepEqual(sessions.active().map(x => x.id), ['pin-b', 'pin-a', 'last', 'first']);
    const before = sessions.list();
    await assert.rejects(sessions.reorder('first', 'pin-a', 'before'), /same group/);
    await assert.rejects(sessions.reorder('pin-a', 'first', 'after'), /same group/);
    await assert.rejects(sessions.reorder('first', 'saved', 'after'), /open tabs/);
    await assert.rejects(sessions.reorder('first', 'last', 'invalid'), /position/);
    assert.deepEqual(sessions.list(), before);
    sessions.get('saved').open = true;
    assert.deepEqual(sessions.active().map(x => x.id), ['pin-b', 'pin-a', 'last', 'first', 'saved']);
    sessions.pin('first', true);
    assert.deepEqual(sessions.active().map(x => x.id), ['pin-b', 'pin-a', 'first', 'last', 'saved']);
    sessions.pin('pin-b', false);
    assert.equal(sessions.active().at(-1).id, 'pin-b');

    sessions.get('first').nativeId = '00000000-0000-0000-0000-000000000001';
    sessions.color('first', '#91B6DA');
    sessions.color('pin-b', '#dba3bb');
    assert.throws(() => sessions.color('first', 'url(https://example.com)'), /valid tab color/);
    assert.throws(() => sessions.color('first', '#123'), /valid tab color/);
    await sessions.close();
    await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
    await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
    service = await createService({ repo, uiDir: path.join(repo, 'ui') });
    reopened = service.sessions;
    assert.deepEqual(reopened.active().map(x => x.id), ['pin-a', 'first', 'last', 'saved', 'pin-b']);
    assert.equal(reopened.get('first').tabColor, '#91b6da');
    assert.equal(reopened.get('first').nativeId, '00000000-0000-0000-0000-000000000001');
    reopened.color('first', null); assert.equal(reopened.get('first').tabColor, null);
    const request = (route, data, method = 'POST') => fetch(service.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await request('/sessions/first', { tabColor: '#91b6da' }, 'PATCH')).status, 200);
    assert.equal((await request('/sessions/first', { tabColor: '#91b6da' }, 'PATCH')).status, 200);
    assert.equal(service.sessions.get('first').name, 'first');
    assert.equal((await request('/sessions/first/reorder', { targetId: 'last', position: 'before' })).status, 400);
    assert.equal((await request('/sessions/pin-b/reorder', { targetId: 'last', position: 'before' })).status, 200);
    const settings = await (await request('/settings', { terminalAppearance: 'original' })).json();
    assert.equal(settings.terminalAppearance, 'original');
    const ignored = await (await request('/settings', { terminalAppearance: 'invalid' })).json();
    assert.equal(ignored.terminalAppearance, 'original');
    const themed = await (await request('/settings', { accentTheme: 'teal' })).json();
    assert.equal(themed.accentTheme, 'teal');
    const invalidTheme = await (await request('/settings', { accentTheme: 'neon' })).json();
    assert.equal(invalidTheme.accentTheme, 'teal');
  } finally { await service?.close(); await sessions.close(); }
});

test('Focus decorations preserve terminal contents and native inverse/background selections', async () => {
  const terminal = new headless.Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  const addon = new serialize.SerializeAddon(); terminal.loadAddon(addon);
  await new Promise(resolve => terminal.write('› My prompt\r\n• Ran command\r\n  └ Details\r\n• Main answer\r\n\x1b[7mSelected\x1b[0m normal\r\n\x1b[44mMenu\x1b[0m plain', resolve));
  const before = addon.serialize();
  const decorations = new Set();
  // The browser renderer exposes this event; headless xterm only needs the
  // initial scheduled draw for this buffer/selection preservation check.
  terminal.onWriteParsed = () => ({ dispose() {} });
  terminal.registerDecoration = options => {
    const decoration = { options, dispose() { decorations.delete(decoration); } };
    decorations.add(decoration); options.marker.onDispose(() => decoration.dispose()); return decoration;
  };
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout };
  let dispose;
  try {
    dispose = decorateTerminal(terminal, 'codex');
    await new Promise(resolve => setTimeout(resolve, 100));
    const at = y => [...decorations].filter(x => x.options.marker.line === y).map(x => x.options);
    assert.equal(at(0)[0].foregroundColor, roleColors.user);
    assert.equal(at(1)[0].foregroundColor, roleColors.detail);
    assert.equal(at(3)[0].foregroundColor, roleColors.agent);
    assert.ok(at(4).every(x => x.x >= 8));
    assert.ok(at(5).every(x => x.x >= 4));
    assert.equal(addon.serialize(), before);
    dispose(); assert.equal(decorations.size, 0); assert.equal(addon.serialize(), before);
  } finally { dispose?.(); globalThis.window = previousWindow; terminal.dispose(); }
});
