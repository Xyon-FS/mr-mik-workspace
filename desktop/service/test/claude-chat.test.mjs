import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeChatTransport } from '../claude-chat-transport.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { Sessions } from '../sessions.mjs';
import { claudeTranscript } from '../native-events.mjs';

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-chat-'));
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd: root, effort: 'high', bypass: options.legacyBypass === true, claudeBypassAllowed: options.savedBypassAllowed };
  const transport = claudeFixture(session.nativeId, options);
  const create = () => new ClaudeChat({ session, stateDir: root, transportFactory: transport.factory });
  const runtime = create(); await runtime.start();
  t.after(async () => { await runtime.close(); transport.close(); });
  return { runtime, transport, session, root, create };
}

test('Claude displays one final answer, hides account fields and waits for native interruption', async t => {
  const { runtime } = await setup(t);
  const events = []; runtime.on('native', event => events.push(event));
  runtime.submit('hello');
  const state = runtime.snapshot();
  assert.equal(state.items.filter(item => item.type === 'agentMessage').length, 1);
  assert.equal(state.turns[0].status, 'completed');
  assert.equal(state.items.find(item => item.type === 'agentMessage').phase, 'final_answer');
  assert.equal(events.filter(event => event.kind === 'turn-completed').length, 1);
  assert.equal(state.capabilities.messageActions, true);
  assert.equal(state.capabilities.attachments, true);
  assert.doesNotMatch(JSON.stringify(state), /NEVER-EXPOSE|"account"/);
  assert.equal(runtime.ready(), true);
  runtime.submit('slow'); assert.equal(runtime.snapshot().working, true);
  await runtime.interrupt();
  assert.equal(runtime.snapshot().working, false);
  assert.equal(runtime.snapshot().turns.at(-1).status, 'interrupted');
});

const testPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('Claude attachments use native image blocks and path references without persisting base64', async t => {
  const { runtime, transport, root, create, session } = await setup(t);
  const image = path.join(root, 'pixel.png'), file = path.join(root, 'note.txt');
  await writeFile(image, testPng); await writeFile(file, 'PRIVATE_FILE_CONTENT');
  await runtime.attach([image, file, root]);
  assert.equal(runtime.ready(), false);
  await assert.rejects(runtime.configure('fixture-sonnet'), /clear your draft/);
  runtime.draft = 'Inspect these.';
  await runtime.persistState(); await runtime.close();
  const resumed = create(); t.after(() => resumed.close()); await resumed.start(session.nativeId);
  assert.equal(resumed.draft, 'Inspect these.');
  assert.deepEqual(resumed.attachments, [image, file, root]);
  const sending = resumed.submit();
  assert.throws(() => resumed.submit('Duplicate'), /attachment operation/);
  await sending;
  assert.equal(transport.calls.filter(message => message.type === 'user').length, 1);
  const content = transport.calls.find(message => message.type === 'user').message.content;
  assert.equal(content[1].source.media_type, 'image/png');
  assert.equal(content[1].source.data, testPng.toString('base64'));
  assert.match(content[0].text, /file\/folder references/);
  assert.doesNotMatch(content[0].text, /PRIVATE_FILE_CONTENT/);
  assert.deepEqual(resumed.attachments, []);
  assert.equal(resumed.snapshot().items.find(item => item.type === 'userMessage').attachments.length, 3);
  await resumed.persistState();
  assert.doesNotMatch(await readFile(resumed.file, 'utf8'), new RegExp(testPng.toString('base64')));
});

test('Claude approval denial and multi-question answers are scoped and one-shot', async t => {
  const { runtime, transport } = await setup(t);
  runtime.submit('approve');
  const request = runtime.snapshot().requests[0];
  runtime.answer(request.id, 'deny');
  assert.throws(() => runtime.answer(request.id, 'allow'), /no longer active/);
  assert.equal(runtime.snapshot().items.find(item => item.type === 'dynamicToolCall').status, 'failed');
  runtime.submit('question');
  const question = runtime.snapshot().requests[0];
  assert.throws(() => runtime.answer(question.id, 'allow', { 'First?': 'A' }), /required/);
  runtime.answer(question.id, 'allow', { 'First?': 'A', 'Second?': 'C, D' });
  assert.deepEqual(transport.calls.at(-1).response.response.updatedInput.answers, { 'First?': 'A', 'Second?': 'C, D' });
});

test('Claude disconnect persists uncertainty, clears requests and never replays the input', async t => {
  const { runtime, session, transport, create } = await setup(t);
  runtime.submit('approve'); session.hasConversation = true;
  [...transport.transports][0].disconnect(); await runtime.close(); await runtime.persistState();
  const resumed = create(); t.after(() => resumed.close()); await resumed.start(session.nativeId);
  assert.equal(resumed.snapshot().uncertain, true); assert.equal(resumed.snapshot().requests.length, 0);
  assert.throws(() => resumed.submit('retry'), /not ready/);
  assert.equal(transport.calls.filter(message => message.type === 'user').length, 1);
  await resumed.acknowledgeUncertain(); resumed.submit('hello');
  assert.equal(transport.calls.filter(message => message.type === 'user').length, 2);
});

test('Claude effort uses native model levels and confirms the applied session setting without writing defaults', async t => {
  const { runtime, transport, session } = await setup(t);
  await runtime.configure('fixture-sonnet', 'low');
  assert.equal(session.effort, 'low'); assert.equal(runtime.snapshot().effort, 'low');
  assert.deepEqual(runtime.snapshot().efforts, ['low', 'high']);
  const before = transport.calls.length;
  await assert.rejects(runtime.configure(undefined, 'medium'), /not reported/);
  assert.equal(transport.calls.length, before);
  assert.ok(transport.calls.some(call => call.request?.subtype === 'apply_flag_settings' && call.request.settings.effortLevel === 'low'));
  assert.equal(transport.calls.some(call => call.request?.subtype === 'update_settings'), false);
});

test('Claude Plan and Build restore operational permissions without model requests or bypass escalation', async t => {
  const { runtime, transport, session } = await setup(t);
  assert.equal(runtime.snapshot().workMode, 'build');
  for (const mode of ['default', 'acceptEdits', 'dontAsk']) {
    await runtime.setPermissionMode(mode);
    await runtime.setWorkMode('plan');
    assert.equal(runtime.snapshot().workMode, 'plan'); assert.equal(runtime.snapshot().buildPermissionMode, mode);
    await runtime.setWorkMode('build');
    assert.equal(runtime.snapshot().workMode, 'build'); assert.equal(runtime.snapshot().permissionMode, mode);
  }
  assert.equal(transport.calls.some(call => call.type === 'user'), false);
  assert.equal(runtime.session.claudeBypassAllowed, false);
  runtime.draft = 'Keep this draft';
  await assert.rejects(runtime.setWorkMode('plan'), /clear your draft/);
  assert.equal(runtime.snapshot().workMode, 'build');
  await assert.rejects(runtime.setWorkMode('invented'), /Choose Plan or Build/);
  runtime.draft = '';
  await runtime.setPermissionMode('plan');
  assert.equal(session.claudePermissionMode, 'plan'); assert.equal(session.bypass, false);
  await runtime.setPermissionMode('default');
  const before = transport.calls.length;
  await assert.rejects(runtime.setPermissionMode('bypassPermissions'), /enabled at launch/);
  await assert.rejects(runtime.setPermissionMode('auto'), /available to this/);
  assert.equal(transport.calls.length, before);
  runtime.submit('slow'); await assert.rejects(runtime.setPermissionMode('plan'), /Finish the turn/);
});

test('saved Build permissions cannot authorize bypass in a chat that did not allow it at launch', async t => {
  const { runtime, root, session, create } = await setup(t, { mode: 'plan' });
  await runtime.persistState(); await runtime.close();
  const file = path.join(root, `claude-chat-${session.id}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8')); saved.buildPermissionMode = 'bypassPermissions';
  await writeFile(file, JSON.stringify(saved));
  const restored = create(); t.after(() => restored.close()); await restored.start();
  assert.equal(restored.snapshot().workMode, 'plan');
  assert.equal(restored.snapshot().buildPermissionMode, 'default');
  await restored.setWorkMode('build');
  assert.equal(restored.snapshot().permissionMode, 'default'); assert.equal(session.claudeBypassAllowed, false);
});

test('Claude policy rejection keeps confirmed permissions; a mismatched acknowledgement disconnects', async t => {
  const rejected = await setup(t, { rejectControl: 'set_permission_mode' });
  await assert.rejects(rejected.runtime.setPermissionMode('plan'), /rejected/);
  assert.equal(rejected.runtime.snapshot().permissionMode, 'default'); assert.equal(rejected.runtime.closed, false);
  const mismatch = await setup(t, { echoMode: 'acceptEdits' });
  await assert.rejects(mismatch.runtime.setPermissionMode('plan'), /did not confirm/);
  assert.equal(mismatch.runtime.snapshot().permissionMode, 'default'); assert.equal(mismatch.runtime.snapshot().connected, false);
});

test('Claude native transport uses a hidden owned child and preserves launch scope without logging diagnostics', async () => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const sent = []; let launch;
  child.stdin = new Writable({ write(chunk, _, done) { sent.push(chunk.toString()); done(); }, final(done) { child.exitCode = 0; child.emit('close', 0); done(); } });
  const transport = claudeChatTransport({ session: { cwd: 'synthetic-work', graphicalModel: 'fixture-model', bypass: false }, env: { SYNTHETIC: 'yes' }, binary: { file: 'fixture-cli', args: [] }, spawnChild(file, args, options) { launch = { file, args, options }; return child; } });
  const output = []; const wire = transport.factory({ data: chunk => output.push(chunk), closed() {} });
  wire.send(JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }));
  const utf8 = Buffer.from('caffè\n'); child.stdout.write(utf8.subarray(0, 5)); child.stdout.write(utf8.subarray(5));
  child.stderr.write('synthetic-private-account');
  assert.equal(output.join(''), 'caffè\n');
  assert.ok(launch.args.includes('--include-partial-messages')); assert.ok(launch.args.includes('stdio'));
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(launch.options.windowsHide, true); assert.equal(launch.options.shell, false);
  assert.equal(sent.length, 1); await transport.close(); assert.equal(child.exitCode, 0);
});

test('Claude native transport accepts queued large images and bounds outstanding bytes', async () => {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); let drain;
  child.stdin = new Writable({ highWaterMark: 16, write(_, __, done) { drain = done; }, final(done) { child.exitCode = 0; child.emit('close', 0); done(); } });
  const transport = claudeChatTransport({ session: { cwd: 'synthetic-work' }, env: {}, binary: { file: 'fixture-cli', args: [] }, spawnChild: () => child });
  const wire = transport.factory({ data() {}, closed() {} });
  const frame = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { data: 'a'.repeat(6 * 1024 * 1024) } }] } });
  assert.doesNotThrow(() => wire.send(frame));
  assert.throws(() => wire.send(frame), /still draining/);
  assert.equal(wire.isOpen(), true);
  drain(); await transport.close();
});

test('Claude sessions restore project associations, model and display history after service recreation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-session-'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  let sessions, restored; const fixtures = [];
  const inject = manager => { manager.createGraphicalRuntime = options => { const fixture = claudeFixture(options.session.nativeId, { mode: options.session.claudePermissionMode, effort: options.session.effort }); fixtures.push(fixture); return new ClaudeChat({ ...options, transportFactory: fixture.factory }); }; };
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'native-config');
    sessions = await new Sessions(root, path.join(root, 'state')).init(); inject(sessions);
    const chat = await sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: root, name: 'Claude fixture', projectId: 'project-fixture', cardId: 'card-fixture', repositoryId: 'repository-fixture' });
    const runtime = sessions.get(chat.id).graphical;
    runtime.submit('hello'); await runtime.configure('fixture-sonnet', 'low'); await runtime.setPermissionMode('acceptEdits'); await runtime.setWorkMode('plan');
    const native = await claudeTranscript(root, chat.nativeId); await mkdir(path.dirname(native), { recursive: true });
    const items = runtime.protocol.snapshot().items.filter(item => ['userMessage', 'agentMessage'].includes(item.type));
    await writeFile(native, items.map((item, index) => JSON.stringify({ type: item.type === 'userMessage' ? 'user' : 'assistant', uuid: item.nativeUuid || item.id, sessionId: chat.nativeId, cwd: root, parentUuid: index ? items[index - 1].nativeUuid || items[index - 1].id : null, isSidechain: false, timestamp: new Date(index + 1).toISOString(), message: { role: item.type === 'userMessage' ? 'user' : 'assistant', ...(item.type === 'agentMessage' ? { id: item.id.slice(0, item.id.lastIndexOf(':')), stop_reason: 'end_turn' } : {}), content: [{ type: 'text', text: item.text }] } })).join('\n') + '\n');
    await sessions.close(); sessions = null;
    restored = await new Sessions(root, path.join(root, 'state')).init(); inject(restored); await restored.restore();
    const item = restored.get(chat.id);
    assert.equal(item.status, 'running'); assert.equal(item.graphicalModel, 'fixture-sonnet');
    assert.equal(item.projectId, 'project-fixture'); assert.equal(item.cardId, 'card-fixture'); assert.equal(item.repositoryId, 'repository-fixture');
    assert.equal(item.graphical.snapshot().items.length, 2); assert.equal(item.nativeId, chat.nativeId);
    assert.equal(item.graphical.snapshot().permissionMode, 'plan'); assert.equal(item.effort, 'low');
    assert.equal(item.graphical.snapshot().buildPermissionMode, 'acceptEdits');
    await item.graphical.setWorkMode('build'); assert.equal(item.graphical.snapshot().permissionMode, 'acceptEdits');
    assert.equal(fixtures.flatMap(fixture => fixture.calls).filter(message => message.type === 'user').length, 1);
  } finally {
    await sessions?.close(); await restored?.close(); for (const fixture of fixtures) fixture.close();
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  }
});
