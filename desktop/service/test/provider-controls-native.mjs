// Opt-in native Claude controls against a localhost-only model simulator.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';
import { claudeChatTransport } from '../claude-chat-transport.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

if (!process.argv.includes('--run')) throw new Error('Pass --run for isolated native controls.');
let runtime, transport, requests = 0, counts = 0;
const frames = [];
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  if (request.url.includes('count_tokens')) { counts++; response.end('{"input_tokens":42}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.end('{}'); return; }
  requests++; assert.ok(requests <= 3, 'Unexpected local inference count');
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const message = { id: `msg_synthetic_controls_${requests}`, type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: 'Synthetic summary: keep the fixture marker and continue safely.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 42, output_tokens: 12 } };
  if (input.stream) {
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.end(event('message_start', { message: { ...message, content: [], stop_reason: null } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: message.content[0].text } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }) + event('message_stop', {}));
  } else response.end(JSON.stringify(message));
});
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-controls-native-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-controls-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const nativeId = randomUUID(), folder = path.join(env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const entries = ['Synthetic fixture question', 'Synthetic fixture answer', 'Remember synthetic marker', 'Synthetic marker retained'].map((text, index) => ({ type: index % 2 ? 'assistant' : 'user', uuid: randomUUID(), sessionId: nativeId, cwd, timestamp: new Date(index + 1000).toISOString(), version: '2.1.311', message: { role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }], ...(index % 2 ? { id: `msg_fixture_${index}`, model: 'claude-haiku-4-5-20251001', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 42, output_tokens: 12 } } : {}) } }));
  for (let index = 0; index < entries.length; index++) entries[index].parentUuid = entries[index - 1]?.uuid || null;
  await writeFile(path.join(folder, `${nativeId}.jsonl`), entries.map(item => JSON.stringify(item)).join('\n') + '\n');
  const session = { id: randomUUID(), nativeId, cwd, graphicalModel: 'haiku', effort: 'low' }, binary = claudeBinary();
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--resume', nativeId] } });
  runtime = new ClaudeChat({ session: { ...session, hasConversation: true }, stateDir: root, env, transportFactory: options => transport.factory({ ...options, data: chunk => { for (const line of chunk.split('\n')) { try { const m = JSON.parse(line); frames.push({ type: m.type, subtype: m.subtype, session_id: m.session_id }); } catch { /* Chunks may split frames. */ } } options.data(chunk); } }) });
  await runtime.start(nativeId);
  runtime.draft = 'Preserve synthetic unsent draft';
  await runtime.refreshUsage();
  assert.equal(runtime.draft, 'Preserve synthetic unsent draft');
  assert.ok(runtime.snapshot().usage.context.window > 0);
  assert.equal(runtime.snapshot().usage.plan.available, false);
  assert.equal(requests, 0); assert.equal(counts, 0);
  runtime.draft = ''; const requestId = randomUUID(); await runtime.compact(requestId);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && runtime.snapshot().working) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runtime.snapshot().compaction.status, 'completed'); assert.equal(runtime.protocol.state.sessionId, nativeId);
  assert.ok(frames.some(frame => frame.subtype === 'compact_boundary'));
  const compactCalls = requests; await runtime.compact(requestId); assert.equal(requests, compactCalls);
  await runtime.submit('Continue the synthetic fixture.');
  while (Date.now() < deadline && runtime.snapshot().working) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runtime.snapshot().status, 'ready'); assert.equal(runtime.protocol.state.sessionId, nativeId);
  assert.equal(requests, compactCalls + 1); assert.equal(counts, 0);
  assert.ok(runtime.snapshot().usage.tokens.input > 0);
  console.log('PASS production Claude usage summary without token-count calls, unavailable subscription limits, draft preservation, same-ID compaction boundary and continuation, duplicate receipt without replay. Localhost simulator only.');
} finally {
  await runtime?.close(); await transport?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
