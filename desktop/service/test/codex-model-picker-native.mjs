// Actual Codex TUI, synthetic local catalog/auth, no inference or user profile.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { codexBinary } from '../agents.mjs';
import { CodexModelPicker } from '../model-picker.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';

let proc, terminal, requests = 0, exited;
const server = http.createServer((_request, response) => { requests++; response.writeHead(503); response.end('Synthetic fixture blocks all model requests'); });
const screen = () => Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) || '').join('\n');
async function wait(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(label + '\n' + screen().slice(-6000));
}
try {
  const binary = codexBinary();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-codex-model-picker-')), cwd = path.join(root, 'work'), home = path.join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  const models = ['Sol', 'Terra', 'Luna'].map((name, index) => ({ slug: `gpt-6.1-${name.toLowerCase()}`, display_name: name === 'Sol' ? 'GPT-6.1-Sol' : `GPT-6.1 ${name}`, description: `Synthetic ${name} model`, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: `Synthetic ${effort}` })), shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: index, upgrade: null, model_messages: null, base_instructions: 'Synthetic offline picker fixture. Never submit model prompts.', default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text_and_image', truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 200000, max_context_window: 200000, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false }));
  const catalog = path.join(root, 'models.json'); await writeFile(catalog, JSON.stringify({ models }));
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-native-picker-no-inference' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_catalog_json=${JSON.stringify(catalog)}\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, OPENAI_API_KEY: 'synthetic-native-picker-no-inference', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', TERM: 'xterm-256color' });
  terminal = new headless.Terminal({ cols: 120, rows: 45, scrollback: 200, allowProposedApi: true });
  proc = pty.spawn(binary.file, [...binary.args, '--no-daemon', '--no-alt-screen'], { cwd, env, name: 'xterm-256color', cols: 120, rows: 45, useConpty: true, useConptyDll: true });
  exited = new Promise(resolve => proc.onExit(resolve));
  terminal.onData(data => proc.write(data)); proc.onData(data => terminal.write(data));
  const session = { agent: 'codex', status: 'running', activity: 'idle', process: proc };
  const picker = new CodexModelPicker({ get: () => session, read: async () => ({ screen: screen() }), input: (_id, text) => { assert.ok(['/model', '\r', '1', '2', '3', 's', '\x1b', '\x1b[A', '\x1b[B'].includes(text), 'Only native picker controls are allowed'); proc.write(text); } });
  await wait(() => /^\s*›\s*(?:Ask Codex to do anything)?\s*$/m.test(screen()), 'Native Codex prompt did not appear');
  const until = picker.until.bind(picker); picker.until = (id, parse, timeout) => until(id, parse, Math.max(timeout || 0, 15000));
  const { options } = await picker.open('fixture');
  assert.deepEqual(options.map(item => item.slug), models.map(item => item.slug));
  assert.equal(options.find(item => item.slug === 'gpt-6.1-terra').label, 'GPT-6.1 Terra');
  const result = await picker.choose('fixture', 'gpt-6.1-terra');
  assert.equal(result.confirmed, true); assert.equal(result.model, 'gpt-6.1-terra');
  const reasoning = await picker.openEffort('fixture');
  assert.ok(reasoning.options.some(option => option.active));
  await picker.cancelEffort('fixture');
  assert.equal(requests, 0);
  console.log('PASS actual Codex /model: complete spaced display names, native Terra selection/reasoning confirmation, same terminal, zero model requests. Synthetic catalog and isolated profile only.');
} catch (error) { console.error(screen().slice(-6000)); throw error; } finally {
  if (proc) { try { proc.kill(); } finally { proc._agent?._conoutSocketWorker?.dispose(); } await exited; }
  terminal?.dispose(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
