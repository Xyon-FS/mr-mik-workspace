import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { SharedBrowsers } from '../shared-browser.mjs';
import { claudeBridgeArgs } from '../agents.mjs';

test('Claude shared browser grants stay in environment and are revoked on rotation or chat closure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-browser-scope-'));
  const session = { id: randomUUID(), agent: 'claude', chatInterface: 'chat', process: {}, cwd: root };
  const manager = new SharedBrowsers({ stateDir: root, session: id => id === session.id ? session : null }); manager.origin = 'http://127.0.0.1:12345';
  try {
    const definition = manager.prepare(session, 'chrome'), record = manager.get(session.id);
    const args = claudeBridgeArgs(null, definition), config = JSON.parse(args[1]).mcpServers[definition.serverName];
    assert.equal(config.env.MRMIK_BROWSER_TOKEN, '${MRMIK_BROWSER_TOKEN}');
    assert.equal(config.env.MRMIK_BROWSER_ENDPOINT, '${MRMIK_BROWSER_ENDPOINT}');
    assert.ok(!args.join(' ').includes(record.token)); assert.equal(definition.env.MRMIK_BROWSER_TOKEN, record.token);
    assert.equal(manager.authenticate(record.token), record); assert.equal(record.browser, undefined);
    const next = manager.prepare(session, 'chrome'); assert.throws(() => manager.authenticate(record.token), /expired/);
    assert.equal(manager.authenticate(next.env.MRMIK_BROWSER_TOKEN).id, session.id);
    {
      const record = manager.get(session.id);
      record.context = {}; record.status = 'ready'; record.folder = root;
      record.folderInfo = await (await import('node:fs/promises')).lstat(root);
      record.client = { callTool: async request => { await (await import('node:fs/promises')).writeFile(request.arguments.filename, Buffer.alloc(4 * 1024 * 1024 + 1)); return { content: [] }; }, close: async () => {} };
      await assert.rejects(manager.call(record, 'browser_take_screenshot'), /exceeds 4 MB/);
      assert.equal(record.busy, false);
    }
    session.agent = 'opencode'; assert.throws(() => manager.get(session.id), /unavailable/);
    session.agent = 'claude'; session.chatInterface = 'cli'; assert.throws(() => manager.get(session.id), /unavailable/);
    session.chatInterface = 'chat'; session.process = null; assert.throws(() => manager.get(session.id), /unavailable/);
  } finally { await manager.close(); }
});

test('Claude browser image results use bounded transient assets, never base64 display history, and restore unavailable honestly', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-browser-result-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: root, agent: 'claude' };
  const fixture = claudeFixture(session.nativeId), create = () => new ClaudeChat({ session, stateDir: root, transportFactory: fixture.factory, browser: { shared: true } });
  const r = create(); t.after(async () => { await r.close(); fixture.close(); }); await r.start(); r.submit('slow');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const wire = [...fixture.transports][0];
  wire.emit({ type: 'assistant', message: { id: 'browser-tool', content: [{ type: 'tool_use', id: 'screenshot', name: 'mcp__fixture__browser_take_screenshot', input: {} }] } });
  wire.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'screenshot', content: [{ type: 'text', text: 'Synthetic browser result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } });
  wire.complete();
  const item = r.snapshot().items.find(item => item.type === 'dynamicToolCall');
  assert.equal(item.resources[0].kind, 'image'); assert.equal(item.resources[0].available, true);
  assert.equal(r.resultAssets.get(item.id)[0].data, png); assert.doesNotMatch(JSON.stringify(r.snapshot()), new RegExp(png));
  await r.persistState(); assert.doesNotMatch(await readFile(r.file, 'utf8'), new RegExp(png));
  await r.close(); assert.equal(r.resultAssets.size, 0);
  const resumed = create(); t.after(() => resumed.close()); await resumed.start();
  const restored = resumed.snapshot().items.find(row => row.id === item.id);
  assert.equal(restored.resources[0].available, false);
});
