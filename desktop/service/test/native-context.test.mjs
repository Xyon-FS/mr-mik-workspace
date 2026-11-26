import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { OpenCodePicker } from '../opencode-picker.mjs';
import { handleV2Control } from '../opencode/v2-tui-controls.mjs';

test('OpenCode context preparation is route/launch scoped, preserves drafts and never submits', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-native-context-')); await mkdir(path.join(root, 'workspace')); await writeFile(path.join(root, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo: root, uiDir: root, restoreSessions: false });
  const original = OpenCodePicker.prototype.command, calls = [], writes = []; let race = false;
  const session = service.sessions.make({ id: randomUUID(), agent: 'opencode', cwd: root, open: true, status: 'running', activity: 'idle', chatInterface: 'cli' });
  session.openCodeLaunchId = 'fixture-launch'; session.status = 'running'; session.activity = 'idle';
  const exits = new Set(), stop = () => { session.process = null; for (const callback of [...exits]) callback({ exitCode: 0 }); };
  session.process = { write: text => { if (text === '\x03') stop(); else writes.push(text); }, kill: stop, onExit: callback => { exits.add(callback); return { dispose: () => exits.delete(callback) }; } }; service.sessions.items.set(session.id, session);
  OpenCodePicker.prototype.command = async (id, action) => { assert.equal(id, session.id); calls.push(action); if (race && action === 'prepare') session.lastInputAt = new Date().toISOString(); return { accepted: true }; };
  const post = body => fetch(`${service.origin}/api/sessions/${session.id}/nativecontext`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  try {
    assert.equal((await post({ action: 'working-project', launchId: 'old' })).ok, false); assert.equal(writes.length, 0);
    assert.equal((await post({ action: 'selector', launchId: 'fixture-launch' })).ok, true); assert.deepEqual(calls, ['prepare', 'context']); assert.equal(writes.length, 0);
    const result = await post({ action: 'working-project', launchId: 'fixture-launch' }); assert.equal(result.ok, true); assert.equal((await result.json()).submitted, false);
    assert.equal(writes.length, 1); assert.match(writes[0], /\x1b\[200~/); assert.ok(!writes[0].includes('\r')); assert.ok(writes[0].includes(root));
    session.lastInputAt = null; race = true;
    assert.equal((await post({ action: 'working-project', launchId: 'fixture-launch' })).ok, false); assert.equal(writes.length, 1);
  } finally { OpenCodePicker.prototype.command = original; await service.close(); }
});
test('OpenCode V2 native context shortcut only dispatches a registered selector from an empty owned prompt', async () => {
  const controls = [], prompt = { plainText: '', traits: { owner: 'opencode', role: 'prompt' } }, state = { launchId: 'launch', nativeId: 'ses_owned', hasConversation: true };
  const api = { ui: { router: { current: () => ({ type: 'session', sessionID: state.nativeId }) } }, renderer: { currentFocusedRenderable: prompt }, keymap: { commands: () => [{ id: 'prompt.skills' }], dispatch: command => controls.push(command) }, data: { session: { status: () => 'idle', permission: { sync: async () => {}, list: () => [] }, form: { sync: async () => {}, list: () => [] } } } };
  const run = () => handleV2Control(api, { id: 'id', action: 'context' }, state, 'launch');
  assert.equal((await run()).accepted, true); assert.deepEqual(controls, ['prompt.skills']);
  prompt.plainText = 'Keep draft'; assert.match((await run()).error, /empty native prompt/); assert.equal(controls.length, 1);
  prompt.plainText = ''; api.keymap.commands = () => []; assert.match((await run()).error, /unavailable/);
});
