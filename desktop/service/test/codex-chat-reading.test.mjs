import test from 'node:test';
import { codexCommandFixture } from './cli-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { Sessions } from '../sessions.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-reading-'));
  const transport = graphicalFixture();
  const runtime = new CodexChat({ session: { cwd: root, codexPermissions: 'ask' }, env: { ...process.env, CODEX_HOME: root }, spawnChild: transport.spawnChild });
  t.after(async () => { await runtime.close(); for (const child of transport.children) child.kill(); }); await runtime.start();
  return { runtime, transport, root };
}

for (const repeat of [false, true]) test(`restored paginated history ${repeat ? 'rejects repeated empty cursors' : 'skips empty initial pages to show messages'}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-empty-history-')), transport = graphicalFixture();
  const runtime = new CodexChat({session: {cwd: root}, env: {CODEX_HOME: root}, spawnChild: transport.spawnChild});
  t.after(() => runtime.close()); const native = runtime.rpc.bind(runtime); let pages = 0;
  runtime.rpc = async (method, params, ...args) => {
    if (method === 'thread/items/list') { pages++; return !params.cursor || repeat ? {data: [], nextCursor: 'older'} : {data: [{turnId: 'old', item: {id: 'visible', type: 'agentMessage', text: 'Restored answer'}}], nextCursor: null}; }
    if (method === 'thread/turns/list') return {data: []};
    const result = await native(method, params, ...args);
    if (method === 'thread/resume') result.thread.historyMode = 'paginated';
    return result;
  };
  if (repeat) await assert.rejects(runtime.start('synthetic-root'), /repeated an empty history page/);
  else { await runtime.start('synthetic-root'); assert.equal(runtime.items.get('visible').text, 'Restored answer'); assert.equal(runtime.truncated, false); }
  assert.equal(pages, 2);
});
test('legacy paging reaches older items without adding them to the live tail; cache remains bounded', async t => {
  const { runtime, transport } = await fixture(t);
  const all = Array.from({ length: 400 }, (_, index) => ({ id: `item-${index}`, type: 'agentMessage', text: String(index) }));
  transport.history.set(runtime.threadId, all); for (const item of all) runtime.upsert(item);
  const page = await runtime.older({ beforeId: 'item-250' });
  assert.equal(page.items.length, 100); assert.equal(page.items[0].id, 'item-150'); assert.equal(page.items.at(-1).id, 'item-249');
  assert.equal(runtime.items.size, 150); assert.equal(runtime.items.has('item-399'), true);
  await runtime.older({ beforeId: 'item-150' }); const first = await runtime.older({ beforeId: 'item-50' });
  assert.equal(first.items[0].id, 'item-0'); assert.equal(first.hasOlder, false); assert.ok(runtime.historyItems.size <= 250); assert.ok(runtime.outputs.size <= 400);
});
test('native cursor paging locates the live anchor and retains all page-boundary items', async t => {
  const { runtime } = await fixture(t); runtime.historyMode = 'paginated';
  const entries = Array.from({ length: 260 }, (_, index) => ({ turnId: 'turn', item: { id: `item-${index}`, type: 'agentMessage', text: String(index) } })).reverse();
  runtime.rpc = async (method, params) => { assert.equal(method, 'thread/items/list'); const start = Number(params.cursor || 0); return { data: entries.slice(start, start + 100), nextCursor: start + 100 < entries.length ? String(start + 100) : null }; };
  const page = await runtime.older({ beforeId: 'item-110' });
  assert.equal(page.items[0].id, 'item-60'); assert.equal(page.items.at(-1).id, 'item-109'); assert.equal(page.nextCursor, '200');
  const older = await runtime.older({ beforeId: page.items[0].id, cursor: page.nextCursor });
  assert.equal(older.items[0].id, 'item-0'); assert.equal(older.items.at(-1).id, 'item-59'); assert.equal(older.hasOlder, false);

  runtime.rpc = async () => ({ data: [{ item: { id: 'unrelated', type: 'agentMessage', text: 'Synthetic' } }], nextCursor: 'repeated' });
  await assert.rejects(runtime.older({ beforeId: 'missing' }), /repeated a history page/);
});
test('delivery reconciliation is read-only and requires a unique recent native user message', async t => {
  const { runtime, transport } = await fixture(t);
  const rpc = runtime.rpc.bind(runtime);
  runtime.rpc = (method, params) => method === 'turn/start' ? Promise.reject(Object.assign(new Error('Synthetic confirmation timeout'), { uncertain: true })) : rpc(method, params);
  runtime.draft = 'Original prompt';
  await assert.rejects(runtime.submit(), /confirmation timeout/);
  assert.equal(runtime.snapshot().uncertain, true); assert.equal(runtime.draft, 'Original prompt');
  await assert.rejects(runtime.submit(), /Finish/);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
  runtime.submission.at = 100000;
  const turn = { id: 'confirmed', startedAt: 100, status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Original prompt' }] }] };
  runtime.rpc = async method => { assert.equal(method, 'thread/read'); return { thread: { turns: [turn] } }; };
  runtime.draft = 'Original prompt'; assert.equal((await runtime.reconcile()).confirmed, true);
  assert.equal(runtime.draft, 'Original prompt'); assert.equal(runtime.uncertain, false);
  runtime.uncertain = true; runtime.rpc = async () => ({ thread: { turns: [turn, { ...turn, id: 'second' }] } });
  assert.equal((await runtime.reconcile()).confirmed, false); assert.equal(runtime.uncertain, true);
  runtime.rpc = async () => ({ thread: { turns: [{ ...turn, status: 'inProgress' }] } });
  runtime.submission.knownTurns = ['confirmed']; assert.equal((await runtime.reconcile()).confirmed, false);
  runtime.submission.knownTurns = [];
  assert.equal((await runtime.reconcile()).confirmed, true); assert.equal(runtime.turnId, 'confirmed'); assert.equal(runtime.snapshot().canInterrupt, true);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('local draft, attachments and explicit preview grants survive a service restart without public/index exposure', async t => {
  await codexCommandFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-draft-restart-')), state = path.join(root, 'state'), hub = path.join(root, 'hub');
  await mkdir(hub); const file = path.join(root, 'private-attachment.txt'), folder = path.join(root, 'private-folder');
  await writeFile(file, 'Synthetic'); await mkdir(folder);
  const transport = graphicalFixture(), account = { label: 'Synthetic', conversationStoreId: 'fixture', sqliteHome: path.join(root, 'sqlite'), env: process.env }; await mkdir(account.sqliteHome);
  const open = async () => { const sessions = await new Sessions(hub, state).init(); sessions.accountContext = async session => ({ ...account, profileId: session.accountProfileId }); sessions.permissionReady = session => session.graphical?.ready() === true; sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild }); return sessions; };
  const original = await open(); t.after(() => original.closed ? undefined : original.close());
  const chat = await original.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: 'fixture', cwd: hub });
  const runtime = original.get(chat.id).graphical; runtime.draft = 'Unsent persisted draft'; runtime.attachments = [file, folder]; runtime.previewPaths.add(await realpath(file));
  await original.close();
  const index = await readFile(path.join(state, 'sessions.json'), 'utf8'); assert.doesNotMatch(index, /Unsent persisted draft|private-attachment/);
  const restored = await open(); t.after(() => restored.close()); await restored.resume(chat.id);
  const result = restored.get(chat.id).graphical;
  assert.notEqual(result.threadId, chat.nativeId); assert.equal(result.draft, 'Unsent persisted draft'); assert.deepEqual(result.attachments, [file, folder]); assert.equal(result.previewPaths.has(await realpath(file)), true);
  assert.equal(result.snapshot().attachmentDetails.find(item => item.path === folder)?.kind, 'folder');
  assert.doesNotMatch(JSON.stringify(restored.list()), /Unsent persisted draft|private-attachment/);
  const emptyId = result.threadId;
  result.draft = ''; result.attachments = []; await restored.setAccountProfile(chat.id, 'second-fixture');
  assert.notEqual(restored.get(chat.id).graphical.threadId, emptyId); assert.equal(restored.get(chat.id).graphical.previewPaths.has(await realpath(file)), true);
});
