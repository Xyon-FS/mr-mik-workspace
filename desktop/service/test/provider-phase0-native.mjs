// Opt-in native contract audit. Synthetic transcripts only; no model requests.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';
import { claudeChatTransport } from '../claude-chat-transport.mjs';
import { ClaudeRuntime } from '../claude-chat-protocol.mjs';

const execute = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url));
const sdkPath = path.join(root, '.cache/provider-phase0-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = [];

async function isolatedEnvironment(base) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']) {
    env[key] = path.join(base, key); await mkdir(env[key], { recursive: true });
  }
  return { ...env, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_CONFIG_CONTENT: '{"enabled_providers":[],"snapshots":false}' };
}

async function claudeWorker(base) {
  const { forkSession, getSessionMessages } = await import(pathToFileURL(sdkPath));
  const dir = path.join(base, 'work'); await mkdir(dir, { recursive: true });
  const id = randomUUID(), uuids = Array.from({ length: 6 }, () => randomUUID());
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const source = path.join(folder, `${id}.jsonl`);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const blocks = [
    ['user', [{ type: 'text', text: 'Synthetic first input; local reference: fixture.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]],
    ['assistant', [{ type: 'tool_use', id: 'tool_fixture', name: 'Read', input: { file_path: path.join(dir, 'fixture.txt') } }]],
    ['user', [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: 'Synthetic tool result' }]],
    ['assistant', [{ type: 'text', text: 'Synthetic first answer' }]],
    ['user', [{ type: 'text', text: 'Synthetic second input' }]],
    ['assistant', [{ type: 'text', text: 'Synthetic second answer' }]],
  ];
  await writeFile(path.join(dir, 'fixture.txt'), 'SYNTHETIC_ONLY');
  const entries = blocks.map(([type, content], index) => ({ type, uuid: uuids[index], parentUuid: index ? uuids[index - 1] : null, sessionId: id, cwd: dir, isSidechain: false, userType: 'external', version: '2.1.311', timestamp: new Date(1_000_000 + index * 1000).toISOString(), message: { role: type, content, ...(type === 'assistant' ? { id: `msg_fixture_${index}`, model: 'synthetic-model', type: 'message', stop_reason: index === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } : {}) } }));
  await writeFile(source, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
  const before = hash(await readFile(source));
  const messages = await getSessionMessages(id, { dir }); assert.equal(messages.length, 6);
  assert.deepEqual((await getSessionMessages(id, { dir, offset: 2, limit: 2 })).map(item => item.uuid), uuids.slice(2, 4));
  const full = await forkSession(id, { dir, title: 'Phase zero full fork' });
  const branch = await forkSession(id, { dir, upToMessageId: uuids[3], title: 'Phase zero bounded fork' });
  assert.notEqual(full.sessionId, id); assert.notEqual(branch.sessionId, id);
  const fullMessages = await getSessionMessages(full.sessionId, { dir }), branchMessages = await getSessionMessages(branch.sessionId, { dir });
  assert.equal(fullMessages.length, 6); assert.equal(branchMessages.length, 4);
  assert.deepEqual(branchMessages.map(item => item.message.content), blocks.slice(0, 4).map(item => item[1]));
  assert.ok(branchMessages.every(item => !uuids.includes(item.uuid)));
  await assert.rejects(forkSession(id, { dir, upToMessageId: randomUUID() }));
  assert.equal(hash(await readFile(source)), before);
  assert.equal(await readFile(path.join(dir, 'fixture.txt'), 'utf8'), 'SYNTHETIC_ONLY');
  let modelRequests = 0, wirePrompts = 0, transport, runtime;
  const endpoint = http.createServer((request, response) => { modelRequests++; request.resume(); response.writeHead(503); response.end(); });
  try {
    await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    const binary = claudeBinary(), session = { id: randomUUID(), nativeId: branch.sessionId, cwd: dir, bypass: false };
    const env = { ...process.env, ANTHROPIC_API_KEY: 'synthetic-no-inference', ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}` };
    transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--bare', '--resume', branch.sessionId] } });
    runtime = new ClaudeRuntime(options => {
      const wire = transport.factory(options), send = wire.send.bind(wire);
      wire.send = line => { if (JSON.parse(line).type === 'user') { wirePrompts++; throw new Error('Inference prohibited in phase zero'); } return send(line); };
      return wire;
    }, { timeoutMs: 15000 });
    runtime.state.sessionId = branch.sessionId; await runtime.connect();
    await runtime.control({ subtype: 'get_settings' });
    assert.equal(runtime.snapshot().status, 'ready');
  } finally {
    runtime?.close(); await transport?.close(); await new Promise(resolve => endpoint.close(resolve));
  }
  assert.equal(modelRequests, 0); assert.equal(wirePrompts, 0); assert.equal(hash(await readFile(source)), before);
  const cli = claudeBinary(), nativeVersion = (await execute(cli.file, [...cli.args, '--version'], { env: process.env, cwd: dir, windowsHide: true, timeout: 10000 })).stdout.trim();
  console.log(JSON.stringify({ provider: 'claude', sdk: '0.3.301', nativeVersion, nativeControlResume: true, fullFork: true, inclusiveMessageFork: true, remappedMessageIds: true, textImageAndToolContentPreserved: true, unknownBoundaryRejected: true, historyPagination: true, sourceUnchanged: true, modelRequests, wirePrompts }));
}

async function openCodeAudit(base, family) {
  const binary = path.join(root, family === 1 ? '.cache/opencode-v1-phase0/node_modules/opencode-windows-x64/bin/opencode.exe' : '.cache/opencode-v2/node_modules/@opencode/cli-windows-x64/bin/opencode.exe');
  const env = await isolatedEnvironment(base), cwd = path.join(base, 'work'); await mkdir(cwd);
  env.OPENCODE_SERVER_PASSWORD = 'synthetic-local-password'; env.OPENCODE_PASSWORD = 'synthetic-local-password';
  const run = async parameters => (await execute(binary, parameters, { env, cwd, windowsHide: true, timeout: 30000, maxBuffer: 2_000_000 })).stdout;
  const version = (await run(['--version'])).trim();
  const id = 'ses_phasezero', mids = ['msg_phasezero001', 'msg_phasezero002', 'msg_phasezero003', 'msg_phasezero004'];
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await writeFile(path.join(cwd, 'fixture.txt'), 'SYNTHETIC_ONLY');
  let archive;
  if (family === 1) {
    archive = { info: { id, projectID: 'global', slug: 'phase-zero', title: 'Synthetic phase zero', directory: cwd, version, time: { created: 1, updated: 9 } }, messages: mids.map((messageID, index) => ({
      info: { id: messageID, sessionID: id, role: index % 2 ? 'assistant' : 'user', time: { created: index + 1, ...(index % 2 ? { completed: index + 2 } : {}) }, agent: 'build', ...(index % 2 ? { parentID: mids[index - 1], providerID: 'fixture', modelID: 'unused', mode: 'build', path: { cwd, root: cwd }, cost: 0, tokens, finish: 'stop' } : { model: { providerID: 'fixture', modelID: 'unused' } }) },
      parts: [{ id: `prt_phasezero${index}`, sessionID: id, messageID, type: 'text', text: `Synthetic ${index}` }, ...(index === 0 ? [{ id: 'prt_phasezeroimage', sessionID: id, messageID, type: 'file', mime: 'image/png', filename: 'fixture.png', url: `data:image/png;base64,${png}` }] : []), ...(index === 1 ? [{ id: 'prt_phasezerotool', sessionID: id, messageID, type: 'tool', tool: 'read', callID: 'phasezero_tool', state: { status: 'completed', input: { filePath: 'fixture.txt' }, output: 'Synthetic tool result', title: 'Read fixture', metadata: {}, time: { start: 2, end: 3 } } }] : [])],
    })) };
  } else {
    archive = { info: { id, title: 'Synthetic phase zero', location: { directory: cwd }, time: { created: 1, updated: 9 }, cost: 0, tokens }, messages: mids.map((messageID, index) => index % 2 ? { id: messageID, type: 'assistant', content: [{ type: 'text', text: `Synthetic ${index}` }, ...(index === 1 ? [{ type: 'tool', name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'Synthetic tool result' }] } }] : [])], time: { created: index + 1, completed: index + 2 } } : { id: messageID, type: 'user', text: `Synthetic ${index}`, ...(index === 0 ? { files: [{ data: png, mime: 'image/png', source: { type: 'inline' } }] } : {}), time: { created: index + 1 } }) };
  }
  const file = path.join(base, 'synthetic-session.json'); await writeFile(file, JSON.stringify(archive));
  if (family === 2) {
    const template = JSON.parse(await run(['api', '--standalone', 'POST', '/api/session', '--data', JSON.stringify({ title: 'Schema template', location: { directory: cwd } })])).data;
    archive.info = { ...template, ...archive.info };
    for (const message of archive.messages) if (message.type === 'assistant') {
      Object.assign(message, { agent: 'build', model: { providerID: 'fixture', id: 'unused' }, cost: 0, tokens, finish: 'stop' });
      for (const content of message.content) if (content.type === 'tool') Object.assign(content, { id: 'phasezero_tool', time: { created: 2, completed: 3 } });
    }
    await writeFile(file, JSON.stringify(archive));
  }
  await run(family === 1 ? ['import', file] : ['session', 'import', file]);
  const exportSession = async target => JSON.parse(await run(family === 1 ? ['export', target] : ['session', 'export', target]));
  const original = await exportSession(id), sourceBefore = hash(JSON.stringify(original.messages));
  assert.equal(original.messages.length, 4);
  let child, output = '', diagnostics = '', exit, tracked;
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  const closeOwned = async () => {
    if (child && !stopped()) {
      child.stdin.end();
      await Promise.race([exit, pause(1500)]);
      if (!stopped()) child.kill();
      await Promise.race([exit, pause(5000)]);
      if (!stopped()) throw new Error('Phase-zero native server did not exit; fixture retained for review.');
    }
  };
  try {
    child = spawn(binary, ['serve', ...(family === 2 ? ['--stdio'] : []), '--port', '0', '--hostname', '127.0.0.1'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    exit = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    // Register the native service with the shared fixture cleanup hook too. A
    // shutdown failure must retain its directory instead of deleting live data.
    tracked = await createService({}, async () => ({ close: closeOwned }));
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-20000); });
    let origin; const deadline = Date.now() + 20000;
    while (!origin && !stopped() && Date.now() < deadline) {
      origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (!origin) await pause(50);
    }
    if (!origin) throw new Error(`OpenCode V${family} server did not become ready: ${diagnostics.slice(-1500)}`);
    const api = async (route, body) => {
      const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Basic ${Buffer.from('opencode:synthetic-local-password').toString('base64')}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      return { ok: response.ok, status: response.status, data: family === 2 ? value.data : value };
    };
    const route = `${family === 1 ? '' : '/api'}/session/${id}`;
    const full = await api(route + '/fork', {}); assert.equal(full.ok, true);
    const cut = await api(route + '/fork', family === 1 ? { messageID: mids[2] } : { before: mids[2] }); assert.equal(cut.ok, true);
    assert.notEqual(full.data.id, id); assert.notEqual(cut.data.id, id);
    const fullCopy = await exportSession(full.data.id), cutCopy = await exportSession(cut.data.id);
    assert.equal(fullCopy.messages.length, 4); assert.equal(cutCopy.messages.length, 2);
    const empty = await api(route + '/fork', family === 1 ? { messageID: mids[0] } : { before: mids[0] });
    assert.equal(empty.ok, true); assert.equal((await exportSession(empty.data.id)).messages.length, 0);
    const wrongFamily = await api(route + '/fork', family === 1 ? { before: mids[2] } : { messageID: mids[2] });
    const wrongFamilyResult = wrongFamily.ok ? await exportSession(wrongFamily.data.id) : null;
    const content = message => family === 1 ? message.parts.map(({ id: _, messageID: __, sessionID: ___, ...part }) => part) : { text: message.text, content: message.content, files: message.files };
    assert.deepEqual(cutCopy.messages.map(content), original.messages.slice(0, 2).map(content));
    const ids = record => record.messages.map(message => family === 1 ? message.info.id : message.id);
    assert.ok(ids(cutCopy).every(value => !mids.includes(value)));
    const missing = await api(route + '/fork', family === 1 ? { messageID: 'msg_nonexistentboundary' } : { before: 'msg_nonexistentboundary' });
    const missingResult = missing.ok ? await exportSession(missing.data.id) : null;
    assert.equal(hash(JSON.stringify((await exportSession(id)).messages)), sourceBefore);
    assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), 'SYNTHETIC_ONLY');
    const result = { provider: 'opencode', family, version, fullFork: true, exclusiveMessageFork: true, emptyForkBeforeFirstInput: true, remappedMessageIds: true, textImageAndToolContentPreserved: true, sourceUnchanged: true, unknownBoundaryStatus: missing.status, unknownBoundaryMessages: missingResult?.messages.length, wrongFamilyParameterStatus: wrongFamily.status, wrongFamilyParameterMessages: wrongFamilyResult?.messages.length, forkBoundary: family === 2 ? cut.data.fork?.boundary.type : null, generationRequestsDispatched: 0, note: 'No generation endpoint invoked; enabled providers empty; isolated native import/fork/export only' };
    evidence.push(result); console.log(JSON.stringify(result));
  } finally {
    if (tracked) await tracked.close(); else await closeOwned();
  }
}

if (args[0] === '--claude-worker') {
  await claudeWorker(path.resolve(args[1]));
} else {
  if (!args.includes('--run')) throw new Error('Pass --run for the isolated zero-inference capability audit.');
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-provider-phase0-'));
  try {
    if (!args.includes('--v2-only')) {
      const env = await isolatedEnvironment(path.join(base, 'claude'));
      const result = await execute(process.execPath, [script, '--claude-worker', path.join(base, 'claude')], { env, cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1_000_000 });
      const proof = JSON.parse(result.stdout.trim()); evidence.push(proof); console.log(JSON.stringify(proof));
    }
    for (const family of args.includes('--v2-only') ? [2] : [1, 2]) await openCodeAudit(path.join(base, `opencode-v${family}`), family);
  } finally { await cleanupFixtures(); }
  await writeFile(path.join(root, '.cache/provider-phase0-evidence.json'), JSON.stringify({ completedAt: new Date().toISOString(), paidCalls: 0, cleanup: 'completed', evidence }, null, 2) + '\n');
}
