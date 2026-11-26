// Actual Claude process with isolated homes and localhost-only synthetic inference.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';

if (!process.argv.includes('--run')) throw new Error('Pass --run for localhost native acceptance.');
const index = process.argv.indexOf('--portable'), serviceRoot = index < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[index + 1], 'App/runtime/service');
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const { claudeChatTransport } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat-transport.mjs')));
let runtime, transport, requests = 0, release;
const inputs = [];
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  if (request.url.includes('count_tokens')) { response.end('{"input_tokens":42}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.end('{}'); return; }
  requests++; const input = JSON.parse(Buffer.concat(chunks)); inputs.push(input);
  if (requests > 2) { response.writeHead(400); response.end('{}'); return; }
  if (requests === 1) await new Promise(resolve => { release = resolve; });
  const message = { id: `msg_queue_${requests}`, type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: 'Synthetic queue answer.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 42, output_tokens: 8 } };
  if (input.stream) {
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.end(event('message_start', { message: { ...message, content: [], stop_reason: null } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Synthetic queue answer.' } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }) + event('message_stop', {}));
  } else response.end(JSON.stringify(message));
});
async function wait(check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Native queue acceptance timed out');
}
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-queue-native-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-local-queue', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
  const session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd, graphicalModel: 'haiku', effort: 'low' };
  const binary = claudeBinary();
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--bare', '--session-id', session.nativeId] } });
  runtime = new ClaudeChat({ session, stateDir: root, env, transportFactory: transport.factory });
  await runtime.start(); assert.equal(requests, 0);
  await runtime.submit('First synthetic queue message.'); await wait(() => !!release);
  const id = randomUUID(); await runtime.pending.enqueue('Second synthetic queue message.', id);
  await runtime.pending.enqueue('Second synthetic queue message.', id);
  assert.equal(requests, 1); assert.equal(runtime.snapshot().queue.length, 1);
  release(); await wait(() => requests === 2 && runtime.snapshot().status === 'ready' && !runtime.pending.pending);
  assert.equal(runtime.protocol.state.sessionId, session.nativeId);
  assert.equal(runtime.snapshot().turns.filter(turn => turn.status === 'completed').length, 2);
  await runtime.pending.enqueue('Second synthetic queue message.', id); assert.equal(requests, 2);
  assert.match(JSON.stringify(inputs[1].messages), /Second synthetic queue message/);
  console.log('PASS actual Claude process: two ordered synthetic turns, no send while busy, one dispatch per receipt, native session identity retained. Localhost simulator only; zero real model calls.');
} finally {
  release?.(); await runtime?.close(); await transport?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
