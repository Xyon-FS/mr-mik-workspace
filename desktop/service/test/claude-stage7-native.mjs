// Actual native Agent/Read/Edit tools, localhost model responses, isolated homes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { pathToFileURL } from 'node:url';
const portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const { claudeChatTransport } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat-transport.mjs')));
import { claudeBinary } from '../agents.mjs';
const { inspectItem } = await import(pathToFileURL(path.join(serviceRoot, 'chat-inspector.mjs')));

let runtime, transport, requests = 0, parentRequests = 0, failure, file;
const events = [], commands = [];
const server = http.createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":42}'); return; }
    if (!request.url.startsWith('/v1/messages')) { response.end('{}'); return; }
    const input = JSON.parse(Buffer.concat(chunks)); requests++; assert.ok(requests <= 8);
    const child = input.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')).includes('Return exactly CHILD_NATIVE_EVIDENCE.'));
    if (!child) parentRequests++;
    const content = child ? [{ type: 'text', text: 'CHILD_NATIVE_EVIDENCE' }]
      : parentRequests === 1 ? [{ type: 'tool_use', id: 'toolu_native_agent', name: 'Agent', input: { description: 'Inspect synthetic fixture data', subagent_type: 'general-purpose', prompt: 'Return exactly CHILD_NATIVE_EVIDENCE. Do not use tools or edit files.' } }]
        : parentRequests === 2 ? [{ type: 'tool_use', id: 'toolu_native_read', name: 'Read', input: { file_path: file } }]
          : parentRequests === 3 ? [{ type: 'tool_use', id: 'toolu_native_edit', name: 'Edit', input: { file_path: file, old_string: 'old line', new_string: 'new line' } }]
            : [{ type: 'text', text: 'Parent fixture complete.' }];
    if (requests === 1) assert.ok(input.tools.some(tool => tool.name === 'Agent'));
    const message = { id: `msg_stage7_${requests}`, type: 'message', role: 'assistant', model: input.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 42, output_tokens: 10 } };
    if (input.stream) {
      response.setHeader('content-type', 'text/event-stream');
      const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      let body = event('message_start', { message: { ...message, content: [], stop_reason: null } });
      body += event('content_block_start', { index: 0, content_block: content[0].type === 'tool_use' ? { ...content[0], input: {} } : { type: 'text', text: '' } });
      body += event('content_block_delta', { index: 0, delta: content[0].type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } : { type: 'text_delta', text: content[0].text } });
      body += event('content_block_stop', { index: 0 }); body += event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      response.end(body + event('message_stop', {}));
    } else response.end(JSON.stringify(message));
  } catch (error) { failure ||= error; response.writeHead(400); response.end('{"error":{"type":"invalid_request_error","message":"Synthetic stage7 fixture failed"}}'); }
});
async function wait(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { if (failure) throw failure; if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(label);
}
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-stage7-native-')), cwd = path.join(root, 'work'); await mkdir(cwd);
  file = path.join(cwd, 'fixture.txt'); await writeFile(file, 'old line\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'TEMP', 'TMP']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(env, { ANTHROPIC_API_KEY: 'synthetic-stage7-no-account', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd, graphicalModel: 'haiku', effort: 'low', bypass: false };
  const binary = claudeBinary();
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--session-id', session.nativeId] } });
  const factory = options => {
    let pending = '';
    return transport.factory({ ...options, data: chunk => {
      pending += chunk;
      let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { const message = JSON.parse(line); if (message.parent_tool_use_id || message.subtype?.startsWith('task_') || message.tool_use_result) events.push({ type: message.type, subtype: message.subtype, parent: message.parent_tool_use_id, task: message.task_id, tool: message.tool_use_id, resultKeys: Object.keys(message.tool_use_result || {}) }); } catch { /* Native frame diagnostics only. */ } }
      options.data(chunk);
    } });
  };
  runtime = new ClaudeChat({ session, stateDir: root, transportFactory: factory }); await runtime.start();
  commands.push(...(runtime.protocol.initialization.commands || []).map(command => ({ name: command.name, builtin: command.builtin })));
  assert.equal(requests, 0); runtime.prepareReview({ type: 'uncommittedChanges' }); assert.equal(requests, 0); runtime.draft = '';
  await runtime.submit('Run the synthetic fixture subagent, then read and update fixture.txt.');
  const approved = new Set();
  await wait(async () => {
    for (const request of runtime.snapshot().requests) {
      if (approved.has(request.id)) continue;
      assert.ok(request.tool === 'Agent' || ['Read', 'Edit'].includes(request.tool) && path.resolve(request.input.file_path) === file, 'Only fixture actions may be approved');
      approved.add(request.id); runtime.answer(request.id, 'allow');
    }
    return runtime.ready() && requests >= 5;
  }, 'Native Agent/Read/Edit turn did not complete');
  assert.equal(await readFile(file, 'utf8'), 'new line\n');
  const agents = runtime.snapshot().subagents; assert.equal(agents.length, 1);
  assert.match(JSON.stringify(runtime.subagents.read(agents[0].id)), /CHILD_NATIVE_EVIDENCE/);
  assert.equal(runtime.snapshot().sessionId, session.nativeId);
  assert.doesNotMatch(JSON.stringify(runtime.snapshot().items.filter(item => item.type === 'agentMessage')), /CHILD_NATIVE_EVIDENCE/);
  const change = runtime.snapshot().items.find(item => item.type === 'fileChange'); assert.ok(change, 'Native Edit result not projected');
  assert.ok(inspectItem(runtime, change.id).files[0].patches[0].rows.some(row => row.text === '+new line'), 'Native structured diff missing');
  console.log(JSON.stringify({ result: 'PASS native Claude subagent ownership/transcript and confirmed Edit diff; localhost model simulation only.', requests, events, commands: commands.filter(command => /review|compact/.test(command.name)) }));
} catch (error) { console.error(JSON.stringify({ requests, events, commands: commands.filter(command => /review|compact/.test(command.name)), state: runtime?.snapshot() })); throw error; }
finally { await runtime?.close(); await transport?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures(); }
