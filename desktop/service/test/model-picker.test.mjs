import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexModelPicker, parseModelPicker, parseReasoningPicker } from '../model-picker.mjs';
import { ClaudeEffortPicker, parseClaudeEffortPicker } from '../claude-model-picker.mjs';

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

test('model picker reads only a complete, numbered native menu', () => {
  assert.deepEqual(parseModelPicker(modelScreen).map(item => item.slug), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
  assert.equal(parseModelPicker('  Select Model and Effort\n  1. GPT-6-Luna'), null);
  assert.equal(parseReasoningPicker(effortScreen, 'GPT-6-Luna').find(item => item.default).key, '2');
});

test('model picker drives the same running terminal and confirms the switch', async () => {
  const process = {};
  const session = { agent: 'codex', status: 'running', process, activity: 'idle' };
  let screen = '› Ask Codex to do anything\n  GPT-6-Sol xhigh · test';
  const inputs = [];
  const sessions = {
    get: () => session,
    read: async () => ({ screen }),
    input: (_id, text) => {
      inputs.push(text);
      if (text === '/model') screen = '› /model\n  GPT-6-Sol xhigh · test';
      if (text === '\r') screen = modelScreen;
      if (text === '3') screen = effortScreen;
      if (text === '2') screen = '• Model changed to gpt-6-luna medium\n› Ask Codex to do anything';
    },
  };
  const picker = new CodexModelPicker(sessions);
  assert.equal((await picker.open('chat')).options.length, 3);
  assert.deepEqual(await picker.choose('chat', 'gpt-6-luna'), { model: 'gpt-6-luna', effort: 'medium', confirmed: true });
  assert.deepEqual(inputs, ['/model', '\r', '3', '2']);
});

test('model picker refuses a draft message and never types into it', async () => {
  const inputs = [];
  const sessions = { get: () => ({ agent: 'codex', status: 'running', process: {}, activity: 'idle' }), read: async () => ({ screen: '› Ask Codex to do anything\n› do not submit this draft\n  GPT-6-Sol xhigh · test' }), input: (_id, text) => inputs.push(text) };
  await assert.rejects(new CodexModelPicker(sessions).open('chat'), /idle Codex prompt/);
  assert.deepEqual(inputs, []);
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

test('Claude native slider parser follows triangle position, exposes only native levels and uses s for session-only changes', async () => {
  const session = { agent: 'claude', status: 'running', activity: 'idle', process: {} };
  let active = 1, screen;
  const menu = () => { const points = [1, 10, 20], track = '─'.repeat(points[active]) + '▲' + '─'.repeat(23 - points[active]); return `Effort\nFaster           Smarter\n${track}\nlow     medium     high\ns for this session only · esc cancel`; };
  screen = menu(); const keys = [];
  assert.equal(parseClaudeEffortPicker(screen).find(row => row.active).slug, 'medium');
  assert.equal(parseClaudeEffortPicker('Effort\nlow medium high'), null);
  const picker = new ClaudeEffortPicker({ get: () => session, read: async () => ({ screen }), input: (id, text) => { keys.push(text); if (text === '\x1b[C') { active++; screen = menu(); } if (text === 's') screen = 'Effort set to high for this session\n❯'; } });
  await picker.openEffort('chat'); await picker.chooseEffort('chat', 'high');
  assert.deepEqual(keys, ['\x1b[C', 's']); assert.equal(session.effort, 'high');
});
