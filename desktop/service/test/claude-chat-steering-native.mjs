// Actual Claude process with isolated homes and localhost-only synthetic inference.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';

if (!process.argv.includes('--run')) throw new Error('Pass --run for localhost native acceptance.');
const index = process.argv.indexOf('--portable'), serviceRoot = index < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[index + 1], 'App/runtime/service');
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const { claudeChatTransport } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat-transport.mjs')));
let runtime, transport, requests = 0, release; const frames = []; let buffer = ''; const events = []; const beforeOutput = process.argv.includes('--before-output'), duringTool = process.argv.includes('--during-tool');
const inputs = [];
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":42}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.end('{}'); return; }
  requests++; const input = JSON.parse(Buffer.concat(chunks)); inputs.push(input);
  if (requests > 2) { response.writeHead(400); response.end('{}'); return; }
  if (requests === 1 && duringTool) {
    assert.ok(input.tools.some(tool => tool.name === 'mcp__SteerFixture__hold'));
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.end(event('message_start', { message: { id: 'msg_fixture_tool', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, usage: { input_tokens: 42, output_tokens: 0 } } }) + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_held_fixture', name: 'mcp__SteerFixture__hold', input: {} } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } }) + event('message_stop', {}));
    return;
  }
  if (requests === 1) {
    if (!beforeOutput) {
      response.setHeader('content-type', 'text/event-stream');
      const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.write(event('message_start', { message: { id: 'msg_partial_steer', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, usage: { input_tokens: 42, output_tokens: 0 } } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Synthetic partial before guidance.' } }));
    }
    await new Promise(resolve => { release = resolve; });
    return;
  }
  assert.match(JSON.stringify(input.messages), /STEER-MARKER/);
  assert.match(JSON.stringify(input.messages), /image\/png/);
  const message = { id: `msg_queue_${requests}`, type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: 'STEER-MARKER confirmed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 42, output_tokens: 8 } };
  if (input.stream) {
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.end(event('message_start', { message: { ...message, content: [], stop_reason: null } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STEER-MARKER confirmed.' } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }) + event('message_stop', {}));
  } else response.end(JSON.stringify(message));
});
async function wait(check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Native queue acceptance timed out');
}
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-steer-native-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-local-queue', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd, graphicalModel: 'haiku', effort: 'low' };
  const binary = claudeBinary();
  const toolReceipt = path.join(root, 'tool-started.txt'), fixture = path.join(root, 'held-mcp.mjs');
  if (duringTool) await writeFile(fixture, `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); if(m.id==null)return; let result={}; if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-steer-tool',version:'1'}}; if(m.method==='tools/list')result={tools:[{name:'hold',description:'Synthetic held test call; no external effects.',inputSchema:{type:'object',properties:{}}}]}; if(m.method==='tools/call'){writeFileSync(process.argv[2],'started');return;} process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  const mcp = duringTool ? ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { SteerFixture: { command: process.execPath, args: [fixture, toolReceipt] } } })] : [];
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--bare', '--session-id', session.nativeId, ...mcp] } });
  runtime = new ClaudeChat({ session, stateDir: root, env, transportFactory: options => transport.factory({ ...options, data: chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) { try { const message = JSON.parse(buffer.slice(0, end)); frames.push({ type: message.type, subtype: message.subtype, command_uuid: message.command_uuid, state: message.state, uuid: message.uuid, ids: message.user_message_uuids }); } catch { /* Chunk may be incomplete. */ } buffer = buffer.slice(end + 1); }
    options.data(chunk);
  } }) });
  await runtime.start(); assert.equal(requests, 0);
  runtime.on('native', event => events.push(event));
  assert.equal(runtime.steering.available, true);
  if (duringTool) await wait(async () => JSON.stringify(await runtime.protocol.control({subtype:'mcp_status'})).includes('connected'));
  await runtime.submit('First synthetic steer message.');
  if (duringTool) await wait(async () => {
    const request = runtime.snapshot().requests[0]; if (request) { assert.equal(request.tool, 'mcp__SteerFixture__hold'); runtime.answer(request.id, 'allow'); }
    return readFile(toolReceipt, 'utf8').then(() => true).catch(() => false);
  });
  else await wait(() => !!release && (beforeOutput || runtime.snapshot().items.some(item => item.type === 'agentMessage' && item.text)));
  const image = path.join(cwd, 'fixture.png'); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  await runtime.attach([image]);
  const id = randomUUID(), target = runtime.snapshot().activeTurnId;
  runtime.draft = 'STEER-MARKER: follow this new instruction and inspect the fixture image.';
  await runtime.steering.steer(runtime.draft, target, id);
  await wait(() => requests === 2 && runtime.snapshot().status === 'ready');
  assert.equal(runtime.protocol.state.sessionId, session.nativeId);
  assert.equal(runtime.snapshot().turns.length, 1); assert.equal(runtime.snapshot().turns[0].id, target);
  assert.equal(runtime.snapshot().turns[0].status, 'completed');
  assert.equal(events.filter(event => event.kind === 'turn-completed').length, 1);
  assert.ok(runtime.snapshot().items.some(item => item.type === 'agentMessage' && /STEER-MARKER confirmed/.test(item.text)));
  assert.equal(runtime.draft, ''); assert.equal(runtime.attachments.length, 0);
  assert.ok(frames.some(frame => frame.type === 'command_lifecycle' && frame.command_uuid === id && frame.state === 'started'));
  assert.ok(frames.some(frame => frame.type === 'result' && frame.ids?.includes(id)));
  await runtime.steering.steer('STEER-MARKER', target, id); assert.equal(requests, 2);
  console.log(`PASS actual Claude priority-now guidance ${duringTool ? 'during an active synthetic MCP call' : beforeOutput ? 'before output' : 'during streaming'}: native UUID receipts, context/image, ${duringTool ? 'guided continuation before the held MCP tool returns' : 'interrupted model request followed by guided continuation'}, one logical activity/session, no premature completion or replay. Localhost simulator only.`);

} finally {
  release?.(); await runtime?.close(); await transport?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
