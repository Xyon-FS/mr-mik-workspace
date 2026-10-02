import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server.mjs';
import { makHistory, mergeMakHistory } from '../mak-history.mjs';
import { Coordinator } from '../coordinator.mjs';
import { randomUUID } from 'node:crypto';
import { codexCommandFixture } from './cli-fixture.mjs';

export async function makFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-coordinator-'));
  const repo = path.join(base, 'hub');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await mkdir(path.join(repo, 'context'), { recursive: true });
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(repo, 'context', 'goals.md'), '# Goals\n');
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: path.join(base, 'home'), env: {} } });
  const request = async (route, data) => {
    const response = await fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const saveProject = async name => { const folder = path.join(base, name); await mkdir(folder, { recursive: true }); return service.projects.save({ name, repositoryPath: folder }); };
  return { base, repo, service, request, saveProject };
}
export function fakeMak(coordinator, action) {
  let next = 0;
  const threads = [], prompts = [];
  coordinator.start = async () => { if (!coordinator.child) { coordinator.child = { kill() {} }; coordinator.threadId = 'global'; coordinator.threads.set('global', 'global'); } };
  coordinator.rpc = async (method, params) => {
    if (method === 'model/list') return { data: [{ model: 'fixture-model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort })) }, { model: 'fixture-other', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high'].map(reasoningEffort => ({ reasoningEffort })) }], nextCursor: null };
    if (method === 'config/read') return { config: { model: 'fixture-model' } };
    if (method === 'thread/start' || method === 'thread/fork') { const id = randomUUID(); ++next; threads.push(id); return { thread: { id } }; }
    if (method === 'thread/resume') { threads.push(params.threadId); return { thread: { id: params.threadId } }; }
    if (method === 'turn/interrupt') return {};
    if (method !== 'turn/start') throw new Error('Unexpected fake protocol call');
    prompts.push({ thread: params.threadId, text: params.input[0].text, effort: params.effort, model: params.model });
    setTimeout(async () => {
      try {
        await action?.(coordinator.active.scope, coordinator.active.operationId);
        await coordinator.message({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: 'Fixture request completed.' } } });
        await coordinator.message({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } });
      } catch (error) { coordinator.active?.reject(error); }
    }, 10);
    return { turn: { id: `turn-${next}` } };
  };
  return { threads, prompts };
}

test('Mik opens an OpenCode worker only after real confirmation, with exact linked card scope and no injected reasoning', async () => {
  const { service, request, saveProject } = await makFixture();
  try {
    const project = await saveProject('OpenCode work');
    const card = await service.projects.createCard({ projectId: project.id, repositoryId: 'primary', title: 'Development' });
    const created = [];
    service.sessions.create = async options => { created.push(options); const chat = service.sessions.make({ ...options, id: randomUUID(), open: false, status: 'stopped' }); service.sessions.items.set(chat.id, chat); return chat; };
    fakeMak(service.coordinator, (scope, id) => service.coordinator.execute('open_chat', { agent: 'opencode', name: 'Feature work' }, id, undefined, scope));
    const result = request('/coordinator', { id: 'oc-worker', text: 'Open an OpenCode worker', scope: { projectId: project.id, cardId: card.id } });
    const deadline = Date.now() + 3000;
    while (!service.coordinator.confirmations.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(created.length, 0); assert.equal(service.coordinator.confirmations.size, 1);
    const confirmation = [...service.coordinator.confirmations.values()][0].confirmation;
    assert.equal(confirmation.scope.cardId, card.id);
    await request('/coordinator/confirm', { id: confirmation.id, approved: true });
    const completed = await result; assert.equal(completed.status, 'completed', completed.result);
    assert.equal(created[0].agent, 'opencode'); assert.equal(created[0].cwd, project.repositoryPath);
    assert.equal(created[0].cardId, card.id); assert.equal(created[0].projectId, project.id);
    assert.equal(created[0].repositoryId, 'primary'); assert.equal(created[0].effort, undefined);
    assert.equal(created[0].bypass, false);
  } finally { await service.close(); }
});

test('Reasoning defaults and per-conversation override persist, fork inherits, and busy/unsupported changes are rejected', async () => {
  const { service, request } = await makFixture();
  try {
    const { prompts } = fakeMak(service.coordinator);
    const caps = await request('/reasoning'); assert.ok(caps.codex.efforts.includes('low'));
    await request('/settings', { defaultWorkerEffort: 'low', defaultClaudeWorkerEffort: 'max', coordinatorEffort: 'high' });
    const initial = await request('/coordinator/conversation', { action: 'new' });
    assert.equal(initial.effort, 'high');
    await request('/settings', { coordinatorEffort: 'medium' });
    assert.equal((await request('/coordinator')).effort, 'high');
    await request('/coordinator/conversation', { action: 'effort', id: initial.id, effort: 'low' });
    await request('/coordinator', { id: 'effort-check', text: 'Inspect fixture', scope: { projectId: null }, conversationId: initial.id });
    assert.equal(prompts[0].effort, 'low');
    const originalThread = service.coordinator.conversation(null).threadId;
    await request('/coordinator/conversation', { action: 'model', id: initial.id, model: 'fixture-other' });
    assert.equal(service.coordinator.conversation(null).effort, 'high');
    await request('/coordinator', { id: 'model-check', text: 'Continue fixture', scope: { projectId: null }, conversationId: initial.id });
    assert.equal(prompts[1].model, 'fixture-other'); assert.equal(prompts[1].effort, 'high');
    assert.equal(service.coordinator.conversation(null).threadId, originalThread);
    await assert.rejects(request('/coordinator/conversation', { action: 'model', id: initial.id, model: 'missing' }), /not in/);
    await request('/coordinator/conversation', { action: 'model', id: initial.id, model: 'fixture-model' });
    await request('/coordinator/conversation', { action: 'effort', id: initial.id, effort: 'low' });
    const fork = await request('/coordinator/conversation', { action: 'fork' }); assert.equal(fork.effort, 'low');
    const clean = await request('/coordinator/conversation', { action: 'new' }); assert.equal(clean.effort, 'medium');
    await assert.rejects(request('/coordinator/conversation', { action: 'effort', id: clean.id, effort: 'ultra' }), /not supported/);
    service.coordinator.operationPromises.set('busy', Promise.resolve());
    await assert.rejects(request('/coordinator/conversation', { action: 'effort', id: clean.id, effort: 'low' }), /Wait for Mak/);
    service.coordinator.operationPromises.delete('busy');
    const restored = await new Coordinator({ repo: service.repo, stateDir: service.coordinator.stateDir, settings: () => ({ coordinatorEffort: 'max' }) }).init();
    assert.equal(restored.conversation(null).effort, 'medium');
    assert.equal(restored.conversation(null, initial.id).effort, 'low');
    await assert.rejects(request('/settings', { defaultClaudeWorkerEffort: 'ultra' }), /Invalid reasoning/);
  } finally { service.coordinator.operationPromises.clear(); await service.close(); }
});

test('Mak freezes workspace across UI changes, writes through the Bridge, and persists scoped History', async () => {
  const { repo, service, request, saveProject } = await makFixture();
  try {
    const a = await saveProject('Game A');
    const b = await saveProject('Game B');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fakeMak(service.coordinator, async (scope, id) => { await gate; await service.coordinator.execute('mrmak_create_resource', { kind: 'knowledge', title: 'Lesson', text: 'Workspace A lesson.' }, id, undefined, scope); });
    const working = request('/coordinator', { id: 'frozen-scope', text: 'Save a lesson', scope: { projectId: a.id } });
    while (!service.coordinator.active) await new Promise(resolve => setTimeout(resolve, 10));
    await request('/settings', { selectedProjectId: b.id }); release();
    const result = await working;
    assert.equal(result.status, 'completed'); assert.equal(result.scope.projectId, a.id);
    assert.equal((await service.projects.resources('knowledge', a.id, 'relevant')).length, 1);
    assert.equal((await service.projects.resources('knowledge', b.id, 'relevant')).length, 0);
    const history = JSON.parse(await readFile(path.join(repo, '.mrmak', 'mak-history.json'), 'utf8'));
    assert.equal(history.operations[0].scope.projectId, a.id);
    assert.equal((await request(`/coordinator?projectId=${b.id}`)).history.length, 0);
    assert.equal((await request(`/coordinator?projectId=${a.id}`)).history.length, 1);
    const restart = await new Coordinator({ repo, stateDir: path.join(repo, '.mrmak') }).init();
    assert.equal(restart.history(a.id)[0].result, result.result);
    assert.equal((await request('/coordinator', { id: 'frozen-scope', text: 'Save a lesson', scope: { projectId: a.id } })).result, result.result);
  } finally { await service.close(); }
});

test('model confirmed flag cannot bypass a real UI confirmation; decline and stop do not write Context', async () => {
  const { repo, service, request } = await makFixture();
  try {
    fakeMak(service.coordinator, (scope, id) => service.coordinator.execute('mrmak_context', { action: 'save', name: 'goals.md', text: '# Changed', expectedRevision: null, confirmed: true }, id, undefined, scope));
    for (const mode of ['decline', 'cancel']) {
      const working = request('/coordinator', { id: mode, text: 'Change goals', scope: { projectId: null } });
      while (!service.coordinator.confirmations.size) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await readFile(path.join(repo, 'context', 'goals.md'), 'utf8'), '# Goals\n');
      const confirmation = [...service.coordinator.confirmations.values()][0].confirmation;
      if (mode === 'decline') await request('/coordinator/confirm', { id: confirmation.id, approved: false });
      else await request('/coordinator/cancel', { id: mode });
      const result = await working;
      assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
      assert.equal(await readFile(path.join(repo, 'context', 'goals.md'), 'utf8'), '# Goals\n');
      assert.equal(service.coordinator.confirmations.size, 0);
    }
  } finally { await service.close(); }
});

test('Mak conversation threads stay separate and reuse the correct workspace', async () => {
  const { service, request, saveProject } = await makFixture();
  try {
    const a = await saveProject('A'), b = await saveProject('B');
    const { threads, prompts } = fakeMak(service.coordinator);
    for (const [index, projectId] of [a.id, b.id, a.id].entries()) await request('/coordinator', { id: `separate-${index}`, text: `Question ${index}`, scope: { projectId } });
    assert.equal(threads.length, 2);
    assert.equal(prompts[0].thread, prompts[2].thread); assert.notEqual(prompts[0].thread, prompts[1].thread);
    assert.ok(prompts[1].text.includes(b.id)); assert.ok(!prompts[1].text.includes('Question 0'));
  } finally { await service.close(); }
});

test('scoped Mak rejects cards and chats from another workspace before touching them', async () => {
  const { service, request, saveProject } = await makFixture();
  try {
    const a = await saveProject('A'), b = await saveProject('B');
    const card = await service.projects.createCard({ projectId: a.id, title: 'Card A' });
    await assert.rejects(request('/coordinator', { id: 'wrong-card', text: 'Read this', scope: { projectId: b.id, cardId: card.id } }), /outside this workspace/);
    service.sessions.items.set('foreign-chat', { id: 'foreign-chat', projectId: a.id });
    await assert.rejects(service.coordinator.execute('read_chat', { id: 'foreign-chat' }, 'cross-chat', undefined, { projectId: b.id }), /outside this request workspace/);
    service.sessions.items.clear();
  } finally { await service.close(); }
});

test('Mak History normalizes interrupted work, strips runtime fields and merges IDs without replay or duplication', () => {
  const old = { id: 'one', text: 'Read a card', at: '2026-09-30T00:00:00Z', status: 'running', scope: { projectId: null }, nativeThreadId: 'not-portable', token: 'not-portable' };
  const incoming = { ...old, status: 'completed', result: 'Read.' };
  const merged = mergeMakHistory({ operations: [old] }, { operations: [incoming] });
  assert.equal(merged.operations.length, 1); assert.equal(merged.operations[0].status, 'completed');
  assert.ok(!JSON.stringify(merged).includes('not-portable'));
  assert.equal(makHistory({ operations: [old] }).operations[0].status, 'interrupted');
  assert.throws(() => makHistory({ operations: [{ ...old, scope: { projectId: '../outside' } }] }), /Invalid/);
});

test('Mak derives the working project from its card and rejects conflicting selections', async () => {
  const { service, request, saveProject, repo } = await makFixture();
  try {
    const project = await saveProject('Game');
    const linked = await service.projects.createCard({ projectId: project.id, title: 'Unity work', repositoryId: 'primary' });
    const planning = await service.projects.createCard({ projectId: project.id, title: 'Planning' });
    await assert.rejects(request('/coordinator', { id: 'wrong-planning', text: 'Read card', scope: { projectId: project.id, cardId: linked.id, repositoryId: null } }), /must match the selected card/);
    await assert.rejects(request('/coordinator', { id: 'wrong-project', text: 'Read card', scope: { projectId: project.id, cardId: planning.id, repositoryId: 'primary' } }), /must match the selected card/);
    const { MakActions } = await import('../mak-actions.mjs');
    const actions = new MakActions({ projects: service.projects, registry: async () => JSON.parse(await readFile(path.join(repo, 'workspace/workspace.json'), 'utf8')) });
    assert.equal((await actions.scope({ projectId: project.id, cardId: linked.id })).repositoryId, 'primary');
    assert.equal((await actions.scope({ projectId: project.id, cardId: planning.id })).repositoryId, null);
  } finally { await service.close(); }
});

test('Mak resumes the same native thread after restart; new/fork/history stay isolated and never replay actions', async () => {
  const { repo, service, request } = await makFixture();
  try {
    const firstProtocol = fakeMak(service.coordinator);
    await request('/coordinator', { id: randomUUID(), text: 'Remember the fixture.', scope: { projectId: null } });
    const first = service.coordinator.conversation(null);
    const restarted = await new Coordinator({ repo, stateDir: service.coordinator.stateDir, context: () => ({}), execute: async () => { throw new Error('Unexpected replay'); } }).init();
    const protocol = fakeMak(restarted);
    await restarted.ask({ id: randomUUID(), text: 'Continue.', scope: { projectId: null } });
    assert.equal(protocol.prompts[0].thread, first.threadId);
    assert.ok(!protocol.prompts[0].text.includes('Remember the fixture.'));
    const fork = await restarted.newConversation(null, true);
    assert.notEqual(fork.threadId, first.threadId); assert.equal(fork.parentId, first.id);
    assert.equal(restarted.history(null, fork.id).length, 2);
    const clean = await restarted.newConversation(null);
    assert.equal(clean.threadId, null); assert.equal(restarted.history(null, clean.id).length, 0);
    await restarted.selectConversation(null, first.id);
    assert.equal(restarted.conversation(null).threadId, first.threadId);
    assert.equal(firstProtocol.prompts.length, 1);
    restarted.close();
  } finally { await service.close(); }
});

test('CLI submit/interrupt are scoped terminal keys and do not close a process; native fork keeps associations', async t => {
  const binary = await codexCommandFixture(t);
  const { service, request, saveProject } = await makFixture();
  const project = await saveProject('Controls');
  try {
    const session = service.sessions.make({ id: randomUUID(), agent: 'codex', name: 'Fixture', projectId: project.id, repositoryId: 'primary', cwd: project.repositoryPath, nativeId: randomUUID(), status: 'running', activity: 'working', open: true });
    const keys = []; session.process = { write: key => keys.push(key), kill() {} };
    service.sessions.items.set(session.id, session);
    await request(`/sessions/${session.id}/control`, { action: 'interrupt' }); assert.deepEqual(keys, ['\x1b']); assert.ok(session.process);
    session.activity = 'idle'; session.attention = false;
    await request(`/sessions/${session.id}/control`, { action: 'submit' }); assert.equal(keys[1], '\r');
    session.attention = true;
    await assert.rejects(request(`/sessions/${session.id}/control`, { action: 'submit' }), /not ready/);
    const { terminalCommand } = await import('../agents.mjs');
    const codex = terminalCommand('codex', { resumeId: session.nativeId, fork: true, cwd: session.cwd });
    assert.equal(codex.file, binary.file); assert.equal(codex.args[0], binary.script);
    assert.ok(codex.args.includes('fork')); assert.ok(!codex.args.includes('resume'));
    const oldAppData = process.env.APPDATA;
    try {
      process.env.APPDATA = path.join(service.coordinator.stateDir, 'fixture-appdata');
      const script = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      await mkdir(path.dirname(script), { recursive: true }); await writeFile(script, '// Argument fixture; never executed.');
      const claude = terminalCommand('claude', { resumeId: session.nativeId, nativeId: randomUUID(), fork: true });
      assert.ok(claude.args.includes('--fork-session')); assert.ok(claude.args.includes('--session-id'));
    } finally { if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData; }
    session.process = null;
  } finally { await service.close(); }
});
