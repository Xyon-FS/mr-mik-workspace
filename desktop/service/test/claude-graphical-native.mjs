// Explicit control-only acceptance. No native account or model prompt is used.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { claudeBinary } from '../agents.mjs';
import { claudeChatTransport } from '../claude-chat-transport.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

if (!process.argv.includes('--control-only')) throw new Error('Pass --control-only for the isolated zero-prompt native check.');
let requests = 0, runtime, transport, peer, peerTransport;
const server = http.createServer((request, response) => { requests++; request.resume(); response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"type":"api_error","message":"Inference disabled"}}'); });
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-graphical-native-'));
  for (const name of ['home', 'config', 'appdata', 'local', 'work']) await mkdir(path.join(root, name));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const binary = claudeBinary();
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'local'), ANTHROPIC_API_KEY: 'synthetic-no-inference', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: path.join(root, 'work'), bypass: false };
  transport = claudeChatTransport({ session, env, binary: { file: binary.file, args: [...binary.args, '--bare', '--session-id', session.nativeId] } });
  let prompts = 0;
  const factory = options => {
    const wire = transport.factory(options), send = wire.send.bind(wire);
    wire.send = line => { const message = JSON.parse(line); if (message.type === 'user') { prompts++; throw new Error('Native proof blocks user prompts.'); } return send(line); };
    return wire;
  };
  runtime = new ClaudeChat({ session, stateDir: root, transportFactory: factory });
  await runtime.start(); assert.equal(runtime.snapshot().connected, true);
  const settingsFile = path.join(root, 'config', 'settings.json');
  const settingsBefore = await readFile(settingsFile, 'utf8').catch(() => null);
  assert.ok(runtime.models().length > 0, 'Native initialize must supply the model catalog');
  await runtime.configure(runtime.models()[0].value);
  await runtime.configure(undefined, 'low'); assert.equal(runtime.snapshot().effort, 'low');
  assert.equal(runtime.snapshot().capabilities.effort, true);
  await runtime.setPermissionMode('plan'); assert.equal(runtime.snapshot().permissionMode, 'plan');
  const peerSession = { id: randomUUID(), nativeId: randomUUID(), cwd: path.join(root, 'work'), bypass: false };
  peerTransport = claudeChatTransport({ session: peerSession, env, binary: { file: binary.file, args: [...binary.args, '--bare', '--session-id', peerSession.nativeId] } });
  peer = new ClaudeChat({ session: peerSession, stateDir: root, transportFactory: peerTransport.factory });
  await peer.start(); assert.equal(peer.snapshot().permissionMode, 'default');
  assert.notEqual(peer.snapshot().effort, runtime.snapshot().effort, 'Changing effort in one process must not change the other process default');
  for (const mode of ['acceptEdits', 'dontAsk', 'default']) { await runtime.setPermissionMode(mode); assert.equal(runtime.snapshot().permissionMode, mode); }
  await assert.rejects(runtime.setPermissionMode('bypassPermissions'), /enabled at launch/);
  await runtime.protocol.control({ subtype: 'interrupt' });
  await peer.close(); await peerTransport.close(); await runtime.close(); await transport.close();
  assert.equal(await readFile(settingsFile, 'utf8').catch(() => null), settingsBefore);
  assert.equal(prompts, 0); assert.equal(requests, 0);
  console.log('PASS: production Claude controls, applied effort readback, Ask/Plan/Accept edits/Deny unapproved actions, peer isolation, unchanged native settings file and idle interrupt. Zero user prompts; zero mock inference requests.');
} finally {
  await peer?.close(); await peerTransport?.close(); await runtime?.close(); await transport?.close();
  await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
