// Actual Claude TUI, synthetic account and blocked localhost inference only.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { claudeBinary } from '../agents.mjs';
import { ClaudeModelPicker, ClaudeEffortPicker } from '../claude-model-picker.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

let proc, terminal, exited;
const requests = [];
const server = http.createServer((request, response) => { requests.push(request.url); response.writeHead(403); response.end('Synthetic fixture blocks inference'); });
const screen = () => terminal ? Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) || '').join('\n') : '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await pause(80); }
  throw new Error(message);
}
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-picker-')), cwd = path.join(root, 'work'); await mkdir(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const syntheticKey = 'synthetic-picker-no-inference';
  Object.assign(env, { ANTHROPIC_API_KEY: syntheticKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', TERM: 'xterm-256color' });
  const configFile = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), settingsFile = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  await writeFile(configFile, JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.312', theme: 'dark', customApiKeyResponses: { approved: [syntheticKey, syntheticKey.slice(-20)], rejected: [] } }));
  const binary = claudeBinary(); terminal = new headless.Terminal({ cols: 120, rows: 45, scrollback: 200, allowProposedApi: true });
  proc = pty.spawn(binary.file, [...binary.args, '--model', 'haiku', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd, env, name: 'xterm-256color', cols: 120, rows: 45, useConpty: true, useConptyDll: true });
  exited = new Promise(resolve => proc.onExit(resolve)); terminal.onData(data => proc.write(data)); proc.onData(data => terminal.write(data));
  await until(() => screen().includes('Yes, I trust this folder') || /^\s*❯\s*$/m.test(screen()), 'No native startup prompt');
  if (screen().includes('Yes, I trust this folder')) {
    await pause(500); assert.ok(screen().includes(cwd)); proc.write('\x1b[B');
    await until(() => /❯\s+Yes, I trust this folder/.test(screen()), 'Trust highlight did not change'); proc.write('\r');
  }
  await until(() => /^\s*❯\s*$/m.test(screen()) || screen().includes('Do you want to use this API key?'), 'No native account prompt');
  if (screen().includes('Do you want to use this API key?')) {
    await pause(500); assert.ok(screen().includes('picker-no-inference')); proc.write('\x1b[A');
    await until(() => /❯\s+Yes\s*$/m.test(screen()), 'Synthetic-key highlight did not change'); proc.write('\r');
  }
  await until(() => /^\s*❯\s*$/m.test(screen()), 'No empty native prompt');
  const defaults = async () => {
    const read = async file => JSON.parse(await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
    const config = await read(configFile), settings = await read(settingsFile);
    return { model: config.model, effort: config.effortLevel, settingsModel: settings.model, settingsEffort: settings.effortLevel };
  };
  const before = await defaults(), keys = [];
  const session = { agent: 'claude', status: 'running', activity: 'idle', process: proc };
  const sessions = { get: () => session, read: async () => ({ screen: screen() }), input: (_id, key) => { assert.ok(['/model', '/effort', '\r', 's', '\x1b', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'].includes(key)); keys.push(key); proc.write(key); }, changed() {}, persist: async () => {} };
  const models = new ClaudeModelPicker(sessions), efforts = new ClaudeEffortPicker(sessions);
  for (const picker of [models, efforts]) { const nativeUntil = picker.until.bind(picker); picker.until = (id, parse, timeout) => nativeUntil(id, parse, Math.max(timeout || 0, 10000)); }
  let menu = await models.open('fixture');
  assert.ok(menu.options.some(row => row.label === 'Haiku' && row.current));
  assert.ok(menu.options.some(row => row.label === 'Fable'), 'Include every numbered native model');
  await models.choose('fixture', menu.options.find(row => row.label === 'Fable').slug);
  menu = await models.open('fixture'); assert.equal(menu.options.find(row => row.current).label, 'Fable');
  await models.choose('fixture', menu.options.find(row => row.current).slug); // Kept model confirmation.
  menu = await models.open('fixture'); await models.choose('fixture', menu.options.find(row => row.label === 'Haiku').slug);
  const effortMenu = await efforts.openEffort('fixture');
  assert.deepEqual(effortMenu.options.map(row => row.slug), ['low', 'medium', 'high', 'xhigh', 'max']);
  await efforts.chooseEffort('fixture', 'low'); assert.equal(session.effort, 'low');
  assert.equal((await efforts.openEffort('fixture')).options.find(row => row.active).slug, 'low');
  await efforts.cancelEffort('fixture');
  assert.deepEqual(await defaults(), before, 'Session-only selections must not change future-chat defaults');
  assert.equal(requests.length, 0); assert.equal(session.process, proc);
  console.log('PASS actual Claude TUI: full model list, Fable selection, current-model confirmation, reasoning slider with separate Ultracode toggle, session-only defaults and same process; zero model requests.');
} catch (error) { console.error(screen().slice(-6500)); throw error; }
finally {
  if (proc) { try { proc.kill(); } finally { proc._agent?._conoutSocketWorker?.dispose(); } await exited; }
  terminal?.dispose(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
