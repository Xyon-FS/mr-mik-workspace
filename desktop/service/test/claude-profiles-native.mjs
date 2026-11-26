// Actual installed Claude CLI, synthetic credentials and localhost model only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';

const index = process.argv.indexOf('--portable'), serviceRoot = index < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[index + 1], 'App/runtime/service');
const { ClaudeProfiles, readClaudeProfileIdentity } = await import(pathToFileURL(path.join(serviceRoot, 'claude-profiles.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs'))), { claudeChatTransport } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat-transport.mjs')));
let requests = 0, runtime, transport, failure;
const server = http.createServer(async (request, response) => {
  try {
    const parts = []; for await (const part of request) parts.push(part);
    if (!request.url.includes('/v1/messages') || request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return; }
    requests++; assert.ok(requests <= 2); const input = JSON.parse(Buffer.concat(parts)), name = request.url.split('/')[1], answer = `Native isolated ${name}`;
    const message = { id: `msg_${name}`, type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
    if (!input.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
    response.setHeader('content-type', 'text/event-stream'); const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.end(event('message_start', { message: { ...message, content: [], stop_reason: null } }) + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + event('message_stop', {}));
  } catch (error) { failure = error; response.writeHead(400); response.end('{}'); }
});
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-profiles-native-')), home = path.join(root, 'home'), cwd = path.join(root, 'work'); await mkdir(home); await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) { env[key] = key === 'HOME' || key === 'USERPROFILE' ? home : path.join(root, key); await mkdir(env[key], { recursive: true }); }
  Object.assign(env, { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
  const current = path.join(home, '.claude'); await mkdir(current); await writeFile(path.join(current, 'sentinel.txt'), 'ORIGINAL UNCHANGED');
  const profiles = new ClaudeProfiles({ root: path.join(root, 'accounts'), env, home });
  const rows = [await profiles.create('A'), await profiles.create('B')], contexts = await Promise.all(rows.map(row => profiles.context(row.id, cwd)));
  for (let i = 0; i < 2; i++) {
    const context = contexts[i], email = `synthetic-${i}@example.test`;
    await writeFile(path.join(context.directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `synthetic-no-access-${i}`, refreshToken: `synthetic-no-refresh-${i}`, expiresAt: Date.now() + 86400000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro' } }));
    await writeFile(path.join(context.directory, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: randomUUID(), emailAddress: email, organizationUuid: randomUUID() }, hasCompletedOnboarding: true }));
    const identity = await readClaudeProfileIdentity(context.env); assert.equal(identity.status, 'logged-in'); assert.equal(identity.email, email);
  }
  assert.notEqual((await readClaudeProfileIdentity(contexts[0].env)).identity, (await readClaudeProfileIdentity(contexts[1].env)).identity);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (let i = 0; i < 2; i++) {
    const name = i ? 'B' : 'A', context = contexts[i], session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd, accountProfileId: rows[i].id, graphicalModel: 'haiku', effort: 'low', bypass: false };
    const nativeEnv = { ...context.env, ANTHROPIC_API_KEY: 'synthetic-localhost-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/${name}`, ENABLE_TOOL_SEARCH: 'false' }, binary = claudeBinary(nativeEnv);
    transport = claudeChatTransport({ session, env: nativeEnv, binary: { file: binary.file, args: [...binary.args, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--session-id', session.nativeId] } });
    runtime = new ClaudeChat({ session, stateDir: path.join(root, `state-${name}`), env: nativeEnv, transportFactory: transport.factory }); await runtime.start(); await runtime.submit('Reply briefly. Do not use tools.');
    const deadline = Date.now() + 30000; while (runtime.snapshot().status !== 'ready' && Date.now() < deadline) { if (failure) throw failure; await new Promise(resolve => setTimeout(resolve, 80)); }
    assert.equal(runtime.snapshot().status, 'ready'); assert.match(JSON.stringify(runtime.snapshot().items), new RegExp(`Native isolated ${name}`));
    const history = await runtime.history.read(); assert.match(JSON.stringify(history), new RegExp(`Native isolated ${name}`)); assert.doesNotMatch(JSON.stringify(history), new RegExp(`Native isolated ${i ? 'A' : 'B'}`));
    await runtime.close(); runtime = null; await transport.close(); transport = null;
  }
  assert.equal(requests, 2); assert.deepEqual(await readdir(current), ['sentinel.txt']); assert.equal(await readFile(path.join(current, 'sentinel.txt'), 'utf8'), 'ORIGINAL UNCHANGED');
  console.log('PASS actual Claude profiles: two native auth/status identities from synthetic stores, independent native conversations and SDK history, unchanged original directory and HOME. Two localhost model responses; zero real provider requests/login.');
} finally { await runtime?.close(); await transport?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures(); }
