import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexModelPicker } from '../model-picker.mjs';
import { ClaudeEffortPicker, parseClaudeEffortPicker } from '../claude-model-picker.mjs';
import { claudeEffortScreen } from './claude-picker-layouts.mjs';

const modelScreen = `  Select Model and Effort
  1. GPT-6-Astra (default)  Frontier intelligence
› 2. GPT-6-Sol (current)    Everyday work
  3. GPT-6-Luna             Easier tasks
  enter select · esc back`;
const effortScreen = `  Select Reasoning Level for GPT-6-Luna
  1. Low                Fast
  2. Medium (default)   Balanced
  3. High               More
  enter default · s session · esc back`;

test('Codex picker selects spaced Terra through its native row and confirms the canonical slug', async () => {
  const session = { agent: 'codex', status: 'running', activity: 'idle', process: {} };
  let screen = modelScreen.replace('GPT-6-Luna', 'GPT-6.1 Terra');
  const keys = [];
  const picker = new CodexModelPicker({ get: () => session, read: async () => ({ screen }), input: (_id, key) => {
    keys.push(key);
    if (key === '3') screen = effortScreen.replace('GPT-6-Luna', 'GPT-6.1 Terra');
    if (key === '2') screen = 'Model changed to gpt-6.1-terra medium\n› Ask Codex to do anything';
  } });
  const ready = screen;
  screen = '› Ask Codex to do anything\n› do not submit this draft\n  GPT-6-Sol xhigh · test';
  await assert.rejects(picker.open('chat'), /idle Codex prompt/);
  assert.deepEqual(keys, []);
  screen = ready;
  const { options } = await picker.open('chat');
  assert.equal(options[0].label, 'GPT-6-Astra');
  assert.equal(options[1].current, true);
  assert.equal(options[2].key, '3');
  assert.equal(options[2].label, 'GPT-6.1 Terra');
  assert.deepEqual(await picker.choose('chat', 'gpt-6.1-terra'), { model: 'gpt-6.1-terra', effort: 'medium', confirmed: true });
  assert.deepEqual(keys, ['3', '2']);
});

test('Codex reasoning changes only the running session using native highlight and s, and persists after confirmation', async () => {
  const session = { agent: 'codex', status: 'running', activity: 'idle', process: {} };
  let screen = modelScreen, active = 0, persisted = 0;
  const menu = () => `Select Reasoning Level for GPT-6-Sol\n${['Low', 'Medium', 'High'].map((label, i) => `${i === active ? '›' : ' '} ${i + 1}. ${label}`).join('\n')}\nenter default · s session · esc back`;
  const keys = [];
  const picker = new CodexModelPicker({ get: () => session, read: async () => ({ screen }), input: (id, text) => { keys.push(text); if (text === '2') screen = menu(); else if (text === '\x1b[B') { active++; screen = menu(); } else if (text === 's') screen = 'Model changed to gpt-6-sol high\n› Ask Codex to do anything'; }, persist: async () => { persisted++; } });
  assert.equal((await picker.openEffort('chat')).options.length, 3);
  assert.equal((await picker.chooseEffort('chat', 'high')).confirmed, true);
  assert.equal(session.effort, 'high'); assert.equal(persisted, 1);
  assert.deepEqual(keys, ['2', '\x1b[B', '\x1b[B', 's']);
});

test('Claude 2.1.312 effort slider ignores its separate Ultracode toggle and exposes all native levels', async () => {
  const keys = [], session = { agent: 'claude', status: 'running', activity: 'idle', process: {} };
  let active = 1, screen = claudeEffortScreen(active), confirm = true;
  assert.deepEqual(parseClaudeEffortPicker(screen).map(row => row.slug), ['low', 'medium', 'high', 'xhigh', 'max']);
  const picker = new ClaudeEffortPicker({ get: () => session, read: async () => ({ screen }), input: (_id, key) => { keys.push(key); if (key === '\x1b[C') screen = claudeEffortScreen(++active); else if (key === '\x1b[D') screen = claudeEffortScreen(--active); else if (key === 's') screen = confirm ? 'Effort set to max for this session\n❯' : 'Old effort set to low\nCurrent effort is max\n❯'; } });
  await picker.openEffort('fixture'); await picker.chooseEffort('fixture', 'max');
  assert.deepEqual(keys, ['\x1b[C', '\x1b[C', '\x1b[C', 's']); assert.equal(session.effort, 'max');
  screen = claudeEffortScreen(active);
  confirm = false;
  picker.until = async (id, parse) => parse((await picker.sessions.read(id)).screen);
  await picker.openEffort('fixture');
  await assert.rejects(picker.chooseEffort('fixture', 'low'), /not confirmed/);
  assert.equal(session.effort, 'max');
});
