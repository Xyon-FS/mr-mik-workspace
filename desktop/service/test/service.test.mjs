import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import http from 'node:http';
import { createService } from '../server.mjs';
import { sleep } from '../util.mjs';
import { completedTurn, tailNativeFile } from '../native-events.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function fixture() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'desktop-test-'));
  await mkdir(path.join(repo, 'workspace', 'A space'), { recursive: true });
  await mkdir(path.join(repo, 'inbox')); await mkdir(path.join(repo, 'projects'));
  await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'ui', 'index.html'), '<html>Mr. Mik UI</html>');
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(repo, 'workspace', 'A space', 'report.html'), '<html><img src="image.bin"></html>');
  await writeFile(path.join(repo, 'workspace', 'A space', 'image.bin'), Buffer.from('0123456789'));
  await writeFile(path.join(repo, '.env'), 'OPENAI_KEY=not-a-real-key\n');
  const service = await createService({ repo, uiDir: path.join(repo, 'ui') });
  const request = (route, data, headers = {}) => fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { repo, service, request };
}

test('local authorization and report isolation protect the terminal service', async () => {
  const { service, request, repo } = await fixture();
  try {
    assert.equal((await fetch(service.origin + '/api/bootstrap')).status, 401);
    assert.equal((await fetch(service.origin + '/api/mcp')).status, 401);
    assert.equal((await request('/mcp/check', { id: 'not-a-server' }, { Origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await request('/bootstrap', undefined, { Origin: 'https://unrelated.example' })).status, 403);
    const wrongHost = await new Promise(resolve => { http.get(service.origin + '/api/bootstrap', { headers: { Host: 'attacker.example', Authorization: `Bearer ${service.token}` } }, response => { response.resume(); resolve(response.statusCode); }); });
    assert.equal(wrongHost, 403);
    const bootstrap = await (await request('/bootstrap')).json();
    assert.equal(bootstrap.voice.configured, false);
    assert.equal(JSON.stringify(bootstrap).includes('not-a-real-key'), false);
    const disabledVoice = await request('/live/session', { sdp: 'test-offer', clientId: 'test-client' });
    assert.equal(disabledVoice.status, 410);
    assert.match((await disabledVoice.json()).error, /temporarily unavailable/i);
    assert.notEqual(new URL(bootstrap.contentBase).origin, service.origin);
    const report = service.files.url(path.join(repo, 'workspace', 'A space', 'report.html'));
    const response = await fetch(report);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /image\.bin/);
    const image = await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=3-6' } });
    assert.equal(image.status, 206); assert.equal(await image.text(), '3456');
    const suffix = await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=-3' } });
    assert.equal(await suffix.text(), '789');
    assert.equal((await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=30-50' } })).status, 416);
    assert.equal((await fetch(bootstrap.contentBase + '/.env')).status, 403);
    assert.equal((await fetch(bootstrap.contentBase + '/%2e%2e%5c.env')).status, 403);
    assert.equal((await request('/bootstrap', undefined, { Origin: service.contentOrigin })).status, 403);
    const ui = await fetch(service.origin);
    assert.equal(ui.headers.get('x-frame-options'), 'DENY');
    const main = await (await request('/files')).json();
    assert.deepEqual(main.entries.map(item => item.name).sort(), ['inbox', 'projects', 'workspace']);
    const all = await (await request('/files?mode=all')).json();
    assert.ok(all.entries.some(item => item.name === '.env'));
    const envPreview = await (await request('/preview?path=' + encodeURIComponent(path.join(repo, '.env')))).json();
    assert.equal(envPreview.kind, 'text'); // The authorized local user retains access.
  } finally { await service.close(); }
});

test('real ConPTY supports Unicode, reconnect snapshots, resizing, exit and saved history', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { service, request, repo } = await fixture();
  let ws;
  try {
    const response = await request('/sessions', { agent: 'shell', name: 'PTY test', cwd: repo, cols: 85, rows: 25 });
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal(session.status, 'running');
    ws = new WebSocket(service.origin.replace('http:', 'ws:') + '/events', { origin: service.origin });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'auth', token: service.token, clientId: 'test-client' }));
    await until(() => messages.some(item => item.type === 'connected'));
    ws.send(JSON.stringify({ type: 'subscribe', id: session.id }));
    await until(() => messages.some(item => item.type === 'snapshot'));
    ws.send(JSON.stringify({ type: 'resize', id: session.id, cols: 74, rows: 22 }));
    await sleep(400);
    ws.send(JSON.stringify({ type: 'input', id: session.id, data: "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output ('UNICODE-' + [char]0x041F + [char]0x0440 + [char]0x0438 + [char]0x0432 + [char]0x0435 + [char]0x0442)\r" }));
    await until(async () => (await service.sessions.read(session.id)).screen.includes('UNICODE-Привет'));
    const snapshot = await service.sessions.snapshot(session.id);
    assert.equal(snapshot.session.cols, 74); assert.equal(snapshot.session.rows, 22);
    assert.ok(snapshot.data.includes('UNICODE-Привет'));
    assert.ok(messages.some(item => item.type === 'output'));
    await service.sessions.persist();
    service.sessions.input(session.id, 'exit 7\r');
    await until(() => service.sessions.get(session.id).status === 'exited');
    assert.equal(service.sessions.get(session.id).exitCode, 7);
    assert.throws(() => service.sessions.input(session.id, 'unexpected command'), /stopped/);
    await service.sessions.persist();
    ws.close(); await service.close();
    const reopened = await createService({ repo, uiDir: path.join(repo, 'ui') });
    try { const saved = reopened.sessions.list()[0]; assert.equal(saved.status, 'stopped'); assert.match((await reopened.sessions.read(saved.id)).screen, /UNICODE-Привет/); }
    finally { await reopened.close(); }
  } finally { ws?.terminate(); await service.close(); }
});

test('websocket rejects report origins and unauthenticated terminal input', async () => {
  const { service } = await fixture();
  try {
    const wrong = new WebSocket(service.origin.replace('http:', 'ws:') + '/events', { origin: service.contentOrigin });
    await new Promise(resolve => wrong.on('error', resolve));
    const socket = new WebSocket(service.origin.replace('http:', 'ws:') + '/events', { origin: service.origin });
    await new Promise(resolve => socket.on('open', resolve));
    const closed = new Promise(resolve => socket.on('close', code => resolve(code)));
    socket.send(JSON.stringify({ type: 'input', id: 'anything', data: 'whoami\r' }));
    assert.equal(await closed, 1008);
    assert.equal(service.sessions.list().length, 0);
  } finally { await service.close(); }
});

test('coordinator operation IDs prevent replay, including after a restart', async () => {
  const { service } = await fixture();
  try {
    service.coordinator.operations.set('already-routed', { id: 'already-routed', status: 'completed', result: 'Delivered once.' });
    assert.equal((await service.coordinator.ask({ id: 'already-routed', text: 'Send it again' })).result, 'Delivered once.');
    assert.equal(service.coordinator.child, null);
    await service.coordinator.save();
    const { Coordinator } = await import('../coordinator.mjs');
    const restored = await new Coordinator({ repo: service.sessions.repo, stateDir: service.sessions.stateDir }).init();
    assert.equal((await restored.ask({ id: 'already-routed', text: 'Retry' })).status, 'completed');
  } finally { await service.close(); }
});

test('completion notifications require a native final-turn event', async () => {
  assert.equal(completedTurn({ type: 'assistant', message: { stop_reason: 'tool_use' } }, 'claude'), null);
  assert.equal(completedTurn({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn' } }, 'claude'), null);
  assert.equal(completedTurn({ type: 'event_msg', payload: { type: 'task_started' } }, 'codex'), null);
  assert.equal(completedTurn({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }, 'claude').kind, 'turn-completed');
  const { service, repo } = await fixture();
  const file = path.join(repo, 'native.jsonl');
  await writeFile(file, '{"type":"event_msg","payload":');
  const events = [];
  const stop = tailNativeFile(file, 'codex', event => events.push(event));
  try {
    await sleep(100); assert.equal(events.length, 0);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{"type":"task_complete"}}\n');
    await until(() => events.length === 1, 3500);
    assert.equal(events[0].kind, 'turn-completed');
  } finally { stop(); await service.close(); }
});

test('History preserves closed and pinned chats while startup restores only open tabs', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { service, repo, request } = await fixture();
  let reopened;
  try {
    const archived = await service.sessions.create({ agent: 'shell', name: 'Pinned task', cwd: repo });
    service.sessions.pin(archived.id, true);
    await service.sessions.remove(archived.id);
    const restoredTab = await service.sessions.resume(archived.id);
    assert.equal(restoredTab.open, true);
    await service.sessions.remove(archived.id);
    const active = await service.sessions.create({ agent: 'shell', name: 'Current task', cwd: repo });
    await sleep(450);
    service.sessions.input(active.id, "Write-Output ('RESTORE_' + 'CONTEXT_OK')\r");
    await until(async () => (await service.sessions.read(active.id)).screen.includes('RESTORE_CONTEXT_OK'));
    const history = await (await request('/history')).json();
    assert.equal(history[0].id, archived.id);
    assert.equal(history[0].pinned, true);
    assert.equal(history[0].open, false);
    assert.throws(() => service.sessions.rename(active.id, 'Русское название'), /English/);
    const imported = await service.sessions.importConversation({ agent: 'codex', nativeId: '00000000-0000-0000-0000-000000000001', name: 'System Setup', pinned: true, cwd: repo });
    assert.equal(imported.open, false);
    assert.equal(service.sessions.get(imported.id).terminal, null);
    await service.close();
    reopened = await createService({ repo, uiDir: path.join(repo, 'ui'), restoreSessions: true });
    await until(() => reopened.sessions.get(active.id).status === 'running');
    assert.equal(reopened.sessions.get(archived.id).process, null);
    assert.equal(reopened.sessions.get(archived.id).pinned, true);
    assert.equal(reopened.sessions.get(imported.id).name, 'System Setup');
    assert.equal(reopened.sessions.get(imported.id).pinned, true);
    assert.equal(reopened.sessions.get(imported.id).nativeId, imported.nativeId);
    assert.equal(reopened.sessions.get(imported.id).process, null);
    assert.match((await reopened.sessions.read(active.id)).screen, /RESTORE_CONTEXT_OK/);
  } finally { await reopened?.close(); await service.close(); }
});

test('History archives and removes only Mr. Mik records, never a native transcript', async () => {
  const { service, repo, request } = await fixture();
  try {
    const nativeId = '00000000-0000-0000-0000-000000000127';
    const nativeFile = path.join(repo, 'native-transcript.jsonl');
    await writeFile(nativeFile, '{"type":"session_meta"}\n');
    const chat = await service.sessions.importConversation({ agent: 'codex', nativeId, name: 'Old chat', cwd: repo });
    await service.sessions.read(chat.id);
    await service.sessions.persist();
    const screen = path.join(repo, '.mrmak', `screen-${chat.id}.json`);
    assert.equal((await request(`/sessions/${chat.id}/archive`, { archived: true })).status, 200);
    assert.equal(service.sessions.get(chat.id).archived, true);
    assert.equal((await request(`/sessions/${chat.id}/archive`, { archived: false })).status, 200);
    assert.equal(service.sessions.get(chat.id).archived, false);
    const removed = await fetch(service.origin + `/api/sessions/${chat.id}/forget`, { method: 'DELETE', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).nativeConversationUntouched, true);
    assert.equal((await request('/history')).status, 200);
    assert.equal((await (await request('/history')).json()).some(item => item.id === chat.id), false);
    assert.equal(await readFile(nativeFile, 'utf8'), '{"type":"session_meta"}\n');
    await assert.rejects(readFile(screen), { code: 'ENOENT' });
  } finally { await service.close(); }
});

test('closing an unused chat omits it from Mr. Mik History', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { service, repo, request } = await fixture();
  const close = id => fetch(service.origin + `/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${service.token}` } });
  try {
    const empty = await service.sessions.create({ agent: 'shell', name: 'Unused chat', cwd: repo });
    assert.equal((await (await request('/history')).json()).some(item => item.id === empty.id), false);
    const result = await close(empty.id);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).savedInHistory, false);
    assert.equal((await (await request('/history')).json()).some(item => item.id === empty.id), false);
    await assert.rejects(readFile(path.join(repo, '.mrmak', `screen-${empty.id}.json`)), { code: 'ENOENT' });

    const used = await service.sessions.create({ agent: 'shell', name: 'Used terminal', cwd: repo });
    service.sessions.input(used.id, 'Write-Output used\r');
    assert.equal((await (await request('/history')).json()).some(item => item.id === used.id), true);
    const kept = await close(used.id);
    assert.equal((await kept.json()).savedInHistory, true);
    assert.equal((await (await request('/history')).json()).some(item => item.id === used.id), true);
  } finally { await service.close(); }
});

test('pasted images are saved in inbox and inserted as a quoted path without submitting', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const { service, repo } = await fixture();
  try {
    const image = await readFile(path.join(root, 'src-tauri', 'icons', '32x32.png'));
    const upload = await fetch(service.origin + '/api/attachments', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'X-File-Name': encodeURIComponent('../../Screenshot sample.png') }, body: image });
    assert.equal(upload.status, 201);
    const saved = await upload.json();
    assert.ok(saved.path.startsWith(path.join(repo, 'inbox', 'attachments') + path.sep));
    assert.deepEqual(await readFile(saved.path), image);
    const duplicate = await service.files.preview(saved.path);
    assert.equal(duplicate.kind, 'image');
    const rejected = await fetch(service.origin + '/api/attachments', { method: 'POST', headers: { Authorization: `Bearer ${service.token}` }, body: '<script>not an image</script>' });
    assert.equal(rejected.status, 400);
    const unauthenticated = await fetch(service.origin + '/api/attachments', { method: 'POST', body: image });
    assert.equal(unauthenticated.status, 401);
    // Wait for PowerShell readiness rather than racing startup on a cold runner.
    // A wide terminal keeps long CI checkout paths from splitting the filename.
    const shell = await service.sessions.create({ agent: 'shell', name: 'Attachment input', cwd: repo, cols: 500 });
    await until(async () => /\bPS [^\r\n]*>/.test((await service.sessions.read(shell.id, 150)).screen));
    const proc = service.sessions.get(shell.id).process;
    const write = proc.write.bind(proc), input = [];
    proc.write = data => { input.push(data); return write(data); };
    const attached = await fetch(service.origin + `/api/sessions/${shell.id}/attach`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [saved.path] }) });
    assert.equal(attached.status, 200);
    assert.equal((await attached.json()).submitted, false);
    assert.deepEqual(input, ["'" + saved.path.replaceAll("'", "''") + "' "]);
    await until(async () => (await service.sessions.read(shell.id, 150)).screen.includes('Screenshot sample'));
    assert.equal(service.sessions.get(shell.id).status, 'running');
  } finally { await service.close(); }
});

test('pasted images use the chat project, then the selected workspace for unassigned chats', async () => {
  const { service, repo, request } = await fixture();
  try {
    const external = await mkdtemp(path.join(root, '.cache', 'project-test-'));
    const project = await service.projects.save({ name: 'Image project', repositoryPath: external });
    const projectChat = await service.sessions.importConversation({ agent: 'codex', nativeId: 'image-project-chat', name: 'Project chat', cwd: external, projectId: project.id });
    const globalChat = await service.sessions.importConversation({ agent: 'codex', nativeId: 'image-global-chat', name: 'Global chat', cwd: repo });
    const image = await readFile(path.join(root, 'src-tauri', 'icons', '32x32.png'));
    const upload = sessionId => fetch(service.origin + '/api/attachments', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'X-File-Name': encodeURIComponent('Screenshot.png'), 'X-Session-Id': sessionId }, body: image });

    await request('/settings', { selectedProjectId: null });
    const projectResponse = await upload(projectChat.id);
    assert.equal(projectResponse.status, 201);
    const projectImage = await projectResponse.json();
    assert.ok(projectImage.path.startsWith(path.join(repo, 'inbox', 'attachments') + path.sep));

    await request('/settings', { selectedProjectId: project.id });
    const globalResponse = await upload(globalChat.id);
    assert.equal(globalResponse.status, 201);
    const selectedImage = await globalResponse.json();
    await request('/settings', { selectedProjectId: null });
    const unassignedResponse = await upload(globalChat.id);
    assert.equal(unassignedResponse.status, 201);
    const unassignedImage = await unassignedResponse.json();
    const assigned = await service.projects.resources('inbox', project.id, 'project');
    assert.deepEqual(assigned.map(item => path.join(repo, item.path)).sort(), [projectImage.path, selectedImage.path].sort());
    assert.ok((await service.projects.resources('inbox', '', 'global')).some(item => path.join(repo, item.path) === unassignedImage.path));
    assert.deepEqual(await readFile(projectImage.path), image);
    assert.deepEqual(await readFile(selectedImage.path), image);
    assert.deepEqual(await readFile(unassignedImage.path), image);
    assert.equal((await upload('unknown-chat')).status, 404);
  } finally { await service.close(); }
});

test('context access reads project guidance and excludes credential and runtime files', async () => {
  const { service, repo } = await fixture();
  try {
    const { ContextLibrary } = await import('../context.mjs');
    const library = new ContextLibrary(repo);
    await writeFile(path.join(repo, 'projects', 'brief.md'), '# Project brief\nA task description.');
    assert.match((await library.read('projects/brief.md')).text, /task description/);
    await assert.rejects(library.read('.env'), /Private runtime/);
    await mkdir(path.join(repo, '.mrmak'), { recursive: true });
    await writeFile(path.join(repo, '.mrmak', 'runtime.json'), '{}');
    await assert.rejects(library.read('.mrmak/runtime.json'), /Private runtime/);
  } finally { await service.close(); }
});

async function until(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(80); }
  throw new Error('Expected terminal state did not arrive before the deadline');
}
