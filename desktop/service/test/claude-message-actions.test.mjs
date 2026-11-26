import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { prepareClaudeMessageAction, createClaudeMessageBranch } from '../claude-message-actions.mjs';
import { providerMessageReceipt } from '../provider-message-receipts.mjs';

async function fixture(t, withImage = false) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-actions-')), repo = path.join(base, 'hub'), config = path.join(base, 'native');
  await mkdir(repo); await mkdir(config);
  const sessions = await new Sessions(repo, path.join(repo, '.mrmak')).init(), calls = [];
  sessions.createGraphicalRuntime = options => {
    const transport = claudeFixture(options.session.nativeId, { mode: options.session.claudePermissionMode, effort: options.session.effort }); calls.push(transport.calls);
    return new ClaudeChat({ ...options, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, transportFactory: transport.factory });
  };
  t.after(() => sessions.close());
  const created = await sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, effort: 'low', claudePermissionMode: 'plan', name: 'Source' });
  const source = sessions.get(created.id), runtime = source.graphical;
  const image = path.join(repo, 'fixture.png');
  if (withImage) { await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')); await runtime.attach([image]); }
  await runtime.submit('First input'); runtime.submit('Second input');
  const native = runtime.protocol.snapshot().items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)).map((item, index) => ({ type: item.type === 'userMessage' ? 'user' : 'assistant', uuid: item.nativeUuid || item.id, message: { role: item.type === 'userMessage' ? 'user' : 'assistant', ...(item.type === 'agentMessage' ? { id: item.id.slice(0, item.id.lastIndexOf(':')), stop_reason: 'end_turn' } : {}), content: item.type === 'userMessage' ? calls.flat().find(message => message.uuid === item.id).message.content : [{ type: 'text', text: item.text }] }, index }));
  const folder = path.join(config, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder, { recursive: true });
  const nativeFile = path.join(folder, `${source.nativeId}.jsonl`);
  await writeFile(nativeFile, native.map((item, index) => JSON.stringify({ ...item, parentUuid: index ? native[index - 1].uuid : null, sessionId: source.nativeId, cwd: repo, isSidechain: false, timestamp: new Date(index + 1).toISOString() })).join('\n') + '\n');
  const run = (kind, itemId, requestId = randomUUID()) => providerMessageReceipt({ sessions, source, request: { kind, itemId, requestId }, execute: record => createClaudeMessageBranch({ sessions, source, kind, itemId, record }) });
  return { sessions, source, runtime, calls, nativeFile, run, image };
}

test('Claude SDK branch/edit/retry preserve source, drafts, Plan and exact inclusive native boundaries', async t => {
  const { sessions, source, runtime, calls, nativeFile, run } = await fixture(t), before = await readFile(nativeFile, 'utf8');
  runtime.draft = 'Keep original draft';
  const items = runtime.protocol.snapshot().items, first = items.find(item => item.type === 'agentMessage'), secondUser = items.filter(item => item.type === 'userMessage')[1];
  const branch = await run('branch', first.id), child = sessions.get(branch.session.id).graphical;
  assert.equal(child.snapshot().items.length, 2); assert.equal(child.session.claudePermissionMode, 'plan'); assert.equal(child.session.effort, 'low');
  assert.notEqual(child.session.nativeId, source.nativeId); assert.notEqual(child.snapshot().items[0].id, items[0].id);
  assert.equal(calls.flat().filter(message => message.type === 'user').length, 2);
  const edit = await run('edit', secondUser.id), edited = sessions.get(edit.session.id).graphical;
  assert.equal(edited.draft, 'Second input'); assert.equal(edited.snapshot().items.length, 2);
  const requestId = randomUUID(), last = items.filter(item => item.type === 'agentMessage').at(-1);
  const retry = await run('retry', last.id, requestId);
  assert.equal(retry.submitted, true); assert.equal(calls.flat().filter(message => message.type === 'user').length, 3);
  assert.deepEqual(await run('retry', last.id, requestId), retry);
  source.providerMessageReceipts.clear(); assert.deepEqual(await run('retry', last.id, requestId), retry);
  assert.equal(calls.flat().filter(message => message.type === 'user').length, 3);
  assert.equal(runtime.draft, 'Keep original draft'); assert.equal(await readFile(nativeFile, 'utf8'), before);
});

test('Claude interrupted/unknown inputs and durable incomplete receipts never infer or replay', async t => {
  const { sessions, source, runtime, calls, run } = await fixture(t), item = runtime.protocol.state.items.find(item => item.type === 'agentMessage');
  item.nativeUuid = randomUUID(); await assert.rejects(run('retry', item.id), /native boundary differ/);
  const request = { requestId: randomUUID(), kind: 'retry', itemId: 'synthetic' };
  await assert.rejects(providerMessageReceipt({ sessions, source, request, execute: async record => { await record({ stage: 'delivery-reserved' }); throw new Error('Crash simulation'); } }), /Crash/);
  source.providerMessageReceipts.clear();
  await assert.rejects(providerMessageReceipt({ sessions, source, request, execute: () => assert.fail('No replay') }), /already reserved/);
  assert.equal(calls.flat().filter(message => message.type === 'user').length, 2);
});

test('Claude definite missing-image preflight can recover with the same reserved identity after restoration', async t => {
  const { sessions, source, runtime, calls, image } = await fixture(t, true);
  const bytes = await readFile(image), itemId = runtime.protocol.snapshot().items.find(item => item.type === 'agentMessage').id;
  const request = { requestId: randomUUID(), kind: 'retry', itemId };
  const run = () => providerMessageReceipt({ sessions, source, request,
    prepare: () => prepareClaudeMessageAction(runtime, itemId, request.kind),
    execute: record => createClaudeMessageBranch({ sessions, source, itemId, kind: request.kind, record }) });
  await unlink(image);
  await assert.rejects(run(), /ENOENT|no such file/i);
  assert.equal(sessions.items.size, 1); assert.equal(calls.flat().filter(message => message.type === 'user').length, 2);
  await writeFile(image, bytes);
  const result = await run(); assert.equal(result.submitted, true);
  assert.equal(sessions.items.size, 2); assert.equal(calls.flat().filter(message => message.type === 'user').length, 3);
  const userCalls = calls.flat().filter(message => message.type === 'user');
  assert.deepEqual(userCalls[2].message.content, userCalls[0].message.content);
  const child = sessions.get(result.session.id).graphical;
  await child.persistState(); assert.doesNotMatch(await readFile(child.file, 'utf8'), /iVBORw0/);
  assert.deepEqual(await run(), result);
  source.providerMessageReceipts.clear(); assert.deepEqual(await run(), result);
  assert.equal(calls.flat().filter(message => message.type === 'user').length, 3);
  await writeFile(image, Buffer.concat([bytes, Buffer.from('changed')]));
  await assert.rejects(prepareClaudeMessageAction(runtime, itemId, 'retry'), /changed since selection/);
  assert.equal(calls.flat().filter(message => message.type === 'user').length, 3);
});
