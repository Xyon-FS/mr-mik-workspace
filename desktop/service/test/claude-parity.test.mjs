import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { ClaudeSettings } from '../claude-settings.mjs';
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

const menu = active => `Select model\n${active === 0 ? '❯' : ' '} 1. Default (current)\n${active === 1 ? '❯' : ' '} 2. Sonnet\n${active === 2 ? '❯' : ' '} 3. Opus\nEnter to confirm · Esc to cancel`;

test('Claude bordered session-only model picker recognizes current footer and never saves global defaults', async () => {
  let active = 0, screen;
  const render = () => ['│ Select model │', '│ Switch between Claude models. Your pick becomes the default for new sessions. │', `│ ${active === 0 ? '❯' : ' '} Default (current) │`, `│ ${active === 1 ? '❯' : ' '} Sonnet │`, '│ Enter set as default · s use this session only · Esc cancel │'].join('\n');
  screen = render();
  assert.equal(parseClaudeModelPicker(screen)?.length, 2);
  assert.equal(parseClaudeModelPicker(screen.replace(' · s use this session only · Esc cancel', '\n│ s use this session only · Esc cancel'))?.length, 2, 'Wrapped footer retains session-only confirmation');
  assert.equal(parseClaudeModelPicker(screen.replace(' · s use this session only', '')), null);
  assert.equal(parseClaudeModelPicker(screen.replace('│ Enter set as default · s use this session only · Esc cancel │', '')), null);
  const keys = [], session = { agent: 'claude', status: 'running', activity: 'idle', process: {} };
  const picker = new ClaudeModelPicker({ get: () => session, read: async () => ({ screen }), input: (id, key) => { keys.push(key); if (key === '\x1b[B') { active = 1; screen = render(); } else if (key === 's') screen = 'Set model to Sonnet\n❯'; else if (key === '\r') assert.fail('Enter would save the default'); } });
  screen = menu(0);
  await picker.open('fixture');
  screen = screen.replace('Enter to confirm', 'Enter set as default · s use this session only');
  await assert.rejects(picker.choose('fixture', '2'), /picker changed/);
  assert.deepEqual(keys, []);
  screen = render();
  await picker.open('fixture'); await picker.choose('fixture', '2');
  assert.deepEqual(keys, ['\x1b[B', 's']);
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
