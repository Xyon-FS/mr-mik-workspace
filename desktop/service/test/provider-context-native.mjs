// Opt-in skill contract: control-only by default, optional local mock expansion.
// No real model/account or user profile is used.
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

if (!process.argv.includes('--run')) throw new Error('Pass --run for the isolated native control check.');
let runtime, transport, requests = 0, prompts = 0, expanded = false, referenceSeen = false;
const localSend = process.argv.includes('--local-send');
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (!request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":42}'); return; }
  requests++;
  if (!localSend) { response.writeHead(503); response.end(); return; }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  expanded ||= JSON.stringify(input.messages).includes('SYNTHETIC_SKILL_CONTEXT_MARKER');
  referenceSeen ||= JSON.stringify(input.messages).includes('User-selected local file/folder references');
  const message = { id: 'msg_synthetic_context', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 0 } };
  if (input.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
    response.end(event('message_start', { message }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Synthetic native context response.' } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + event('message_stop', {}));
  } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...message, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic native context response.' }] })); }
});
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-context-contract-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  const cwd = path.join(root, 'work'); await mkdir(cwd);
  for (const [name, extra] of [['fixture-context', 'disable-model-invocation: true'], ['hidden-context', 'user-invocable: false']]) {
    const folder = path.join(cwd, '.claude', 'skills', name); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic native skill contract\n${extra}\n---\nSYNTHETIC_SKILL_CONTEXT_MARKER. No filesystem changes or tool calls.\n`);
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-no-inference', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd, bypass: false, graphicalModel: 'haiku', effort: 'low' }, binary = claudeBinary();
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--session-id', session.nativeId] } });
  runtime = new ClaudeChat({ session, stateDir: root, env, transportFactory: options => {
    const wire = transport.factory(options), send = wire.send.bind(wire);
    wire.send = line => { if (JSON.parse(line).type === 'user') { prompts++; if (!localSend || prompts > 1) throw new Error('Native contract blocks additional prompts'); } return send(line); }; return wire;
  } });
  await runtime.start();
  const catalog = await runtime.composer.skills();
  assert.equal(catalog.skills.length, 1); assert.equal(catalog.skills[0].name, 'fixture-context');
  await runtime.composer.add({ type: 'skill', name: 'fixture-context', path: 'native:fixture-context' });
  assert.equal(prompts, 0); assert.equal(requests, 0);
  if (localSend) {
    const image = path.join(cwd, 'synthetic-context.png'); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    await runtime.attach([image]);
    await assert.rejects(runtime.submit('Do not dispatch unsupported context.'), /does not expand.*images/);
    assert.equal(prompts, 0); assert.equal(requests, 0); assert.equal(runtime.composer.items.length, 1);
    runtime.detach(image); await runtime.attach([cwd]);
    await runtime.submit('Check synthetic context.');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && runtime.snapshot().working) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(runtime.snapshot().working, false); assert.equal(runtime.snapshot().uncertain, false);
    assert.equal(prompts, 1); assert.equal(requests, 1); assert.equal(expanded, true); assert.equal(referenceSeen, true);
    assert.ok(runtime.snapshot().items.some(item => item.type === 'agentMessage' && item.text.includes('Synthetic native context response')));
  }
  console.log(`PASS native Claude skill catalog, builtin/hidden exclusion, selection without dispatch${localSend ? ', unsupported image combination blocked, native skill expansion with project reference and one local simulated response' : ''}. No real account/provider used.`);
} finally {
  await runtime?.close(); await transport?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
