import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { ClaudeSettings } from '../claude-settings.mjs';
import { McpInventory } from '../mcp.mjs';
import { claudeTranscript } from '../native-events.mjs';
import { ClaudeModelPicker, parseClaudeModelPicker } from '../claude-model-picker.mjs';
import { terminalCommand } from '../agents.mjs';

test('Claude native skill/plugin overrides preserve unrelated settings and isolate linked projects', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-settings-'));
  const home = path.join(base, 'home'), first = path.join(base, 'first'), second = path.join(base, 'second');
  for (const root of [home, first, second]) {
    await mkdir(path.join(root, '.claude', 'skills', 'report'), { recursive: true });
    await writeFile(path.join(root, '.claude', 'skills', 'report', 'SKILL.md'), '---\nname: report\ndescription: Test report\n---\nFixture');
  }
  const global = path.join(home, '.claude', 'settings.json');
  await writeFile(global, JSON.stringify({ enabledPlugins: { 'fixture@test': true }, env: { PRIVATE_FIXTURE: 'not-real' }, skillOverrides: { report: 'name-only' } }));
  const service = new ClaudeSettings({ root: async id => id === 'first' ? first : second }, { home, env: {} });
  await service.set('first', { kind: 'skill', id: 'report', enabled: false });
  await service.set('first', { kind: 'plugin', id: 'fixture@test', enabled: false });
  assert.equal((await service.list('first')).rows.find(row => row.kind === 'skill').state, 'off');
  assert.equal((await service.list('second')).rows.find(row => row.kind === 'skill').state, 'name-only');
  assert.equal((await service.list('first')).rows.find(row => row.kind === 'plugin').effective, false);
  assert.equal((await service.list('second')).rows.find(row => row.kind === 'plugin').effective, true);
  await service.set('first', { kind: 'skill', id: 'report', enabled: null });
  assert.equal((await service.list('first')).rows.find(row => row.kind === 'skill').state, 'name-only');
  assert.equal(JSON.stringify(await service.list('first')).includes('not-real'), false);
  assert.equal(JSON.parse(await readFile(global, 'utf8')).env.PRIVATE_FIXTURE, 'not-real');
  await service.set('first', { kind: 'plugin', id: 'fixture@test', scope: 'global', enabled: false });
  assert.equal((await service.list('second')).rows.find(row => row.kind === 'plugin').effective, false);
  await assert.rejects(service.set('first', { kind: 'skill', id: 'unknown', enabled: true }), /not found/);
});

test('Claude parked global definitions remain visible but disabled and secrets stay hidden', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-inventory-'));
  await writeFile(path.join(root, '.claude.json'), JSON.stringify({ mrmakDisabledMcpServers: { fixture: { type: 'stdio', command: 'node', env: { PRIVATE_FIXTURE: 'not-real' } } } }));
  const inventory = new McpInventory(root, { home: root, env: {} });
  try {
    const result = await inventory.list(), server = result.servers.find(item => item.client === 'claude');
    assert.equal(server.enabled, false); assert.equal(server.readiness, 'disabled');
    assert.equal(JSON.stringify(result).includes('not-real'), false);
  } finally { inventory.close(); }
});

test('Claude finds only the recorded ID across working folders and rejects ambiguous copies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-resume-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(path.join(root, 'projects', 'old-folder'), { recursive: true });
    const file = path.join(root, 'projects', 'old-folder', `${id}.jsonl`);
    await writeFile(file, '{}\n');
    assert.equal(await claudeTranscript('C:\\New folder', id, { search: true }), file);
    await mkdir(path.join(root, 'projects', 'duplicate'));
    await writeFile(path.join(root, 'projects', 'duplicate', `${id}.jsonl`), '{}\n');
    await assert.rejects(claudeTranscript('C:\\New folder', id, { search: true }), /Multiple native/);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});

const menu = active => `Select model\n${active === 0 ? '❯' : ' '} 1. Default (current)\n${active === 1 ? '❯' : ' '} 2. Sonnet\n${active === 2 ? '❯' : ' '} 3. Opus\nEnter to confirm · Esc to cancel`;
test('Claude model picker recognizes only a complete menu and selects without restarting', async () => {
  assert.equal(parseClaudeModelPicker('User message: Select model\n1. Sonnet'), null);
  assert.equal(parseClaudeModelPicker(menu(0)).length, 3);
  let screen = menu(0), active = 0;
  const input = [];
  const session = { agent: 'claude', status: 'running', activity: 'idle', process: {} };
  const picker = new ClaudeModelPicker({ get: () => session, read: async () => ({ screen }), input: (id, text) => { input.push(text); if (text === '\x1b[B') screen = menu(++active); else if (text === '\r') screen = 'Set model to Sonnet\n❯'; } });
  const process = session.process;
  await picker.open('test');
  assert.equal((await picker.choose('test', '2')).confirmed, true);
  assert.equal(session.process, process);
  assert.deepEqual(input, ['\x1b[B', '\r']);
});

test('Claude launch keeps invocation-only Hub skill suppression and explicit resume path', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-launch-'));
  await writeFile(path.join(base, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'fixture');
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${base}${path.delimiter}${previous || ''}`;
    const launch = terminalCommand('claude', { resumeId: '11111111-1111-4111-8111-111111111111', resumePath: path.join(base, 'old transcript.jsonl'), bridge: { script: path.join(base, 'bridge.mjs'), settings: { skillOverrides: { report: 'off' } } } });
    assert.equal(launch.args[launch.args.indexOf('--resume') + 1], path.join(base, 'old transcript.jsonl'));
    assert.deepEqual(JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]), { skillOverrides: { report: 'off' } });
    assert.notEqual(launch.file, 'powershell.exe');
  } finally { process.env.PATH = previous; }
});
