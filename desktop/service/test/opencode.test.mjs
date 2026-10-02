import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createObserver, validSessionId, finalAnswerPreview } from '../opencode/observer.mjs';
import plugin from '../opencode/plugin.mjs';
import { openCodeRuntimeConfig, readOpenCodeState, watchOpenCode } from '../opencode.mjs';
import { workerDefault } from '../effort.mjs';
import { childEnvironment } from '../agents.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';

test('OpenCode observer binds the exact directory/session and excludes unrelated or empty activity', () => {
  const states = [], directory = path.resolve('fixture');
  const observe = createObserver({ directory, chatId: 'managed', launchId: 'launch', startedAt: 1, save: state => states.push(state) });
  const created = info => observe({ type: 'session.created', properties: { info } });
  created({ id: 'ses_wrong', directory: path.resolve('other') });
  created({ id: 'ses_child', directory, parentID: 'ses_parent' });
  assert.equal(states.length, 0);
  created({ id: 'ses_owned', directory });
  assert.equal(states.at(-1).hasConversation, false);
  observe({ type: 'session.status', properties: { sessionID: 'ses_wrong', status: { type: 'busy' } } });
  assert.equal(states.length, 1);
  observe({ type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } });
  assert.equal(states.at(-1).activity, 'working');
  assert.equal(states.at(-1).hasConversation, true);
  observe({ type: 'message.updated', properties: { info: { sessionID: 'ses_owned', id: 'msg_answer', role: 'assistant', time: { completed: 2 }, finish: 'stop' } } });
  observe({ type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } });
  observe({ type: 'session.idle', properties: { sessionID: 'ses_owned' } });
  assert.equal(states.at(-1).completion, 'msg_answer');
  const count = states.length;
  observe({ type: 'session.idle', properties: { sessionID: 'ses_owned' } });
  assert.equal(states.length, count);
  observe({ type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } });
  observe({ type: 'session.idle', properties: { sessionID: 'ses_owned' } });
  assert.equal(states.at(-1).completion, 'msg_answer');
  assert.equal(states.at(-1).activity, 'idle');
  assert.equal(JSON.stringify(states).includes('token'), false);
});

test('OpenCode runtime Bridge configuration preserves native config and keeps credentials out', async () => {
  const config = openCodeRuntimeConfig({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'local/test', plugin: ['fixture'], mcp: { existing: { enabled: false } }, permission: { skill: { other: 'ask' } } }) }, { script: 'bridge.mjs', hubSkillNames: ['hub-only'] });
  assert.equal(config.model, 'local/test'); assert.equal(config.mcp.existing.enabled, false);
  assert.deepEqual(config.mcp.mrmak_workspace.command, [process.execPath, 'bridge.mjs']);
  assert.equal(config.permission.skill.other, 'ask'); assert.equal(config.permission.skill['hub-only'], 'deny');
  assert.equal(config.plugin.length, 2);
  assert.equal(JSON.stringify(config).includes('TOKEN'), false);
  assert.throws(() => openCodeRuntimeConfig({ OPENCODE_CONFIG_CONTENT: 'invalid' }), /valid JSON/);
  assert.throws(() => openCodeRuntimeConfig({ OPENCODE_CONFIG_CONTENT: '[]' }), /invalid/);
  assert.equal(workerDefault({ defaultWorkerEffort: 'ultra' }, 'opencode'), undefined);
  assert.equal(validSessionId('../ses_test'), false);
});

test('OpenCode History preview reads only the exact final assistant text and ignores stale asynchronous reads', async () => {
  const info = { sessionID: 'ses_owned', id: 'msg_final', role: 'assistant', finish: 'stop', time: { completed: 2 } };
  const part = (type, text, sessionID = 'ses_owned') => ({ sessionID, messageID: 'msg_final', type, text });
  const data = { info, parts: [part('reasoning', 'PRIVATE_REASONING'), part('tool', 'PRIVATE_TOOL'), part('text', 'FOREIGN', 'ses_other'), part('text', 'A'.repeat(500)), part('text', 'Final answer')] };
  const excerpt = finalAnswerPreview(data, 'ses_owned', 'msg_final');
  assert.equal(excerpt.length, 350); assert.ok(excerpt.endsWith('Final answer'));
  assert.equal(excerpt.includes('PRIVATE'), false); assert.equal(excerpt.includes('FOREIGN'), false);
  assert.equal(finalAnswerPreview({ ...data, info: { ...info, error: { name: 'MessageAbortedError' } } }, 'ses_owned', 'msg_final'), '');
  assert.equal(finalAnswerPreview(data, 'ses_other', 'msg_final'), '');
  const states = [], calls = [], pending = [];
  const observe = createObserver({ directory: process.cwd(), nativeId: 'ses_owned', chatId: 'managed', launchId: 'launch', save: state => states.push(state), loadPreview: (session, message) => { calls.push([session, message]); return new Promise(resolve => pending.push(resolve)); } });
  const final = message => { observe({ type: 'message.updated', properties: { info: { ...info, id: message } } }); observe({ type: 'session.idle', properties: { sessionID: 'ses_owned' } }); };
  final('msg_final'); await Promise.resolve(); assert.deepEqual(calls, [['ses_owned', 'msg_final']]);
  observe({ type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } });
  pending.shift()('STALE'); await new Promise(resolve => setImmediate(resolve)); assert.equal(states.at(-1).preview, '');
  final('msg_next'); await Promise.resolve(); pending.shift()('Newest answer'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).completion, 'msg_next'); assert.equal(states.at(-1).preview, 'Newest answer');
  const count = calls.length; observe({ type: 'session.idle', properties: { sessionID: 'ses_owned' } }); assert.equal(calls.length, count);
  const failures = [];
  const failed = createObserver({ directory: process.cwd(), nativeId: 'ses_owned', chatId: 'managed', launchId: 'launch', save: state => failures.push(state), loadPreview: async () => { throw new Error('Private native error'); } });
  failed({ type: 'message.updated', properties: { info } }); failed({ type: 'session.idle', properties: { sessionID: 'ses_owned' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failures.at(-1).completion, 'msg_final'); assert.equal(failures.at(-1).preview, ''); assert.equal(JSON.stringify(failures).includes('Private native error'), false);
});

test('OpenCode preview persists through restart without repeating completion or unread notifications', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-preview-')), stateDir = path.join(repo, '.mrmak');
  const sessions = await new Sessions(repo, stateDir).init();
  const id = '22222222-2222-4222-8222-222222222222';
  const chat = sessions.make({ id, agent: 'opencode', nativeId: 'ses_owned', name: 'Preview', cwd: repo, open: false }); sessions.items.set(id, chat);
  sessions.nativeEvent(chat, { kind: 'turn-completed', id: 'msg_final' }); sessions.seen(id, chat.completionVersion);
  sessions.applyOpenCodePreview(chat, { nativeId: 'ses_other', completion: 'msg_final', preview: 'Wrong session' }); assert.notEqual(chat.preview, 'Wrong session');
  sessions.applyOpenCodePreview(chat, { nativeId: 'ses_owned', completion: 'msg_old', preview: 'Wrong turn' }); assert.notEqual(chat.preview, 'Wrong turn');
  sessions.applyOpenCodePreview(chat, { nativeId: 'ses_owned', completion: 'msg_final', preview: 'Final preview' });
  assert.equal(chat.completionVersion, 1); assert.equal(chat.unread, false); await sessions.close();
  const restored = await new Sessions(repo, stateDir).init();
  try { assert.equal(restored.get(id).preview, 'Final preview'); assert.equal(restored.get(id).completionVersion, 1); assert.equal(restored.get(id).unread, false); } finally { await restored.close(); }
});

test('OpenCode context hook mutates the native array without duplicating orientation', async t => {
  const previous = process.env.MRMAK_OPENCODE_ORIENTATION;
  process.env.MRMAK_OPENCODE_ORIENTATION = 'Fixture Hub orientation';
  t.after(() => { if (previous === undefined) delete process.env.MRMAK_OPENCODE_ORIENTATION; else process.env.MRMAK_OPENCODE_ORIENTATION = previous; });
  const hooks = await plugin({ directory: process.cwd() });
  const system = ['Native instructions'], output = { system };
  await hooks['experimental.chat.system.transform']({}, output);
  await hooks['experimental.chat.system.transform']({}, output);
  assert.equal(output.system, system); assert.equal(system.length, 1);
  assert.equal(system[0].split('Fixture Hub orientation').length, 2);
  assert.equal(childEnvironment().MRMAK_OPENCODE_ORIENTATION, undefined);
});

test('OpenCode state reader/watcher rejects wrong chat and obsolete launches', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-opencode-'));
  const file = path.join(folder, 'state.json');
  await writeFile(file, JSON.stringify({ chatId: 'chat', launchId: 'old', nativeId: 'ses_test', revision: 1 }));
  assert.equal(await readOpenCodeState(file, 'other'), null);
  const received = [], stop = watchOpenCode(file, 'chat', 'current', state => received.push(state));
  try {
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(received.length, 0);
    await writeFile(file, JSON.stringify({ chatId: 'chat', launchId: 'current', nativeId: 'ses_test', revision: 2 }));
    await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(received.length, 1);
  } finally { stop(); }
});

test('OpenCode History recovers its own observed ID and never assigns Codex reasoning', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-opencode-history-'));
  const stateDir = path.join(repo, '.mrmak');
  const sessions = await new Sessions(repo, stateDir).init(); t.after(() => sessions.close());
  const id = '11111111-1111-4111-8111-111111111111';
  const item = sessions.make({ id, agent: 'opencode', name: 'Offline History', cwd: repo, open: false, hasConversation: true });
  sessions.items.set(id, item);
  await mkdir(path.join(stateDir, 'opencode'));
  const file = path.join(stateDir, 'opencode', `${id}.json`);
  await writeFile(file, JSON.stringify({ chatId: id, nativeId: 'ses_owned', launchId: 'previous', revision: 1 }));
  let resumed;
  sessions.launch = async (_session, nativeId) => { resumed = nativeId; };
  await sessions.resume(id);
  assert.equal(resumed, 'ses_owned'); assert.equal(item.effort, undefined);
  await sessions.remove(id); await sessions.forget(id);
  assert.equal(await stat(file).catch(() => null), null);
});

test('OpenCode light transfer preserves History and full transfer explicitly rejects missing native conversations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-opencode-transfer-'));
  const hubs = [];
  for (const name of ['source', 'target']) {
    const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
    for (const folder of ['workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
    await writeFile(path.join(repo, 'projects/registry.json'), JSON.stringify({ projects: [] }));
    const sessions = await new Sessions(repo, stateDir).init(); t.after(() => sessions.close());
    hubs.push({ repo, stateDir, sessions, archive: new PortableArchive(repo, stateDir, sessions, null) });
  }
  const [source, target] = hubs, id = '11111111-1111-4111-8111-111111111111';
  source.sessions.items.set(id, source.sessions.make({ id, agent: 'opencode', nativeId: 'ses_owned', name: 'Offline Transfer', preview: 'Saved answer excerpt', cwd: source.repo, open: false, hasConversation: true, status: 'stopped', createdAt: new Date().toISOString() }));
  source.archive.openCode = { read: async () => null };
  await assert.rejects(source.archive.exportTo(root), /conversation is missing/);
  const light = await source.archive.exportTo(root, { chats: 'light' });
  const preview = await target.archive.preview(light.path); assert.equal(preview.native.length, 0);
  await target.archive.importFrom(light.path);
  assert.equal(target.sessions.list()[0].agent, 'opencode');
  assert.equal(target.sessions.list()[0].nativeId, 'ses_owned');
  assert.equal(target.sessions.list()[0].preview, 'Saved answer excerpt');
  assert.equal(target.sessions.list()[0].cwd, target.repo);
});
