// Local protocol only. Never starts a model turn or uses the user's Codex profile.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../coordinator.mjs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-mak-protocol-'));
const previous = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(base, 'profile');
await mkdir(process.env.CODEX_HOME);
await writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), '[mcp_servers.fixture]\ncommand="fixture-do-not-start"\nenabled=false\n');
const coordinator = new Coordinator({ repo: base, stateDir: path.join(base, 'state'), context: () => ({}), orientation: async () => 'Protocol check only. Never start work.', threadConfig: async () => ({ 'features.apps': false, web_search: 'disabled', mcp_servers: { fixture: { enabled: false } } }), execute: async () => { throw new Error('No actions are authorized by this protocol check.'); } });
try {
  await coordinator.init(); await coordinator.start();
  const catalogue = await coordinator.reasoningCapabilities();
  if (!catalogue.efforts.length || !catalogue.efforts.includes(catalogue.defaultEffort)) throw new Error('Invalid installed model reasoning catalogue.');
  console.log('Installed model reasoning catalogue:', JSON.stringify(catalogue));
  const conversation = await coordinator.newConversation(null);
  await coordinator.ensureThread({ projectId: null }, conversation);
  const global = coordinator.threadId;
  await coordinator.ensureThread({ projectId: 'fixture-workspace' });
  const workspace = coordinator.threadId;
  await coordinator.ensureThread({ projectId: null }, conversation);
  if (!global || global === workspace || coordinator.threadId !== global) throw new Error('Scope thread selection failed.');
  // Seed a private fixture rollout to exercise native resume/fork parsing without inference.
  const seed = randomUUID(), folder = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `rollout-fixture-${seed}.jsonl`), [
    { timestamp: '2026-09-30T00:00:00Z', type: 'session_meta', payload: { id: seed, timestamp: '2026-09-30T00:00:00Z', cwd: base, originator: 'mrmak_test', cli_version: '0.157.1', source: 'cli', model_provider: 'openai' } },
    { timestamp: '2026-09-30T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Protocol fixture only.' }] } },
    { timestamp: '2026-09-30T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture response.' }] } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  conversation.threadId = seed; coordinator.threads.clear(); await coordinator.save();
  await coordinator.ensureThread({ projectId: null }, conversation);
  const fork = await coordinator.newConversation(null, true);
  if (!fork.threadId || fork.threadId === seed) throw new Error('Native fork failed.');
  const child = coordinator.child; const closed = once(child, 'exit'); coordinator.close(); await closed;
  const restored = new Coordinator({ repo: base, stateDir: coordinator.stateDir, context: () => ({}), orientation: coordinator.orientation, threadConfig: coordinator.threadConfig, execute: coordinator.execute });
  try { await restored.init(); await restored.start(); await restored.ensureThread({ projectId: null }, restored.conversation(null)); if (restored.threadId !== fork.threadId) throw new Error('Persistent fork changed its ID.'); }
  finally { restored.close(); }
  console.log('Installed Codex app-server accepted persistent resume/fork across restart with isolated fixture context. No model turn, native worker or user profile was used.');
} finally {
  coordinator.close();
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
}
