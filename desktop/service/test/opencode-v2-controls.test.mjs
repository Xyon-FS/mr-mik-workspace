import test from 'node:test';
import assert from 'node:assert/strict';
import controlsPlugin, { handleV2Control } from '../opencode/v2-tui-controls.mjs';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import path from 'node:path';
import os from 'node:os';

function fixture() {
  const state = { launchId: 'launch', nativeId: 'ses_owned', hasConversation: true };
  const prompt = { plainText: '', traits: { owner: 'opencode', role: 'prompt', capture: ['tab'] } };
  const controls = [], permissions = [], forms = [];
  const api = {
    ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_owned' }) } },
    location: { directory: 'fixture' }, renderer: { currentFocusedRenderable: prompt },
    client: { session: { interrupt: async input => controls.push(input) } },
    keymap: { commands: () => ['model.list', 'variant.list', 'prompt.submit'].map(id => ({ id })), dispatch: command => controls.push(command) },
    data: {
      session: { get: () => ({}), status: () => 'idle', permission: { sync: async () => {}, list: () => permissions }, form: { sync: async () => {}, list: () => forms } },
      location: { model: { list: () => [{ id: 'model', providerID: 'provider', name: 'Public model', variants: [{ id: 'high', PRIVATE_OPTIONS: 'secret' }], PRIVATE_AUTH: 'secret' }] }, provider: { list: () => [{ id: 'provider', name: 'Provider', PRIVATE_TOKEN: 'secret' }] } },
    },
  };
  const run = (action, active) => handleV2Control(api, { id: 'request', action }, state, 'launch', active);
  return { api, prompt, controls, permissions, forms, run, state };
}

test('V2 catalog exposes only public models, plugins and skills without dispatching commands', async () => {
  const f = fixture(), catalog = await f.run('catalog');
  assert.equal(catalog.accepted, true); assert.deepEqual(catalog.models[0].variants, ['high']);
  assert.equal(JSON.stringify(catalog).includes('secret'), false);
  assert.equal(JSON.stringify(catalog).includes('PRIVATE'), false);

  f.api.client.plugin = { list: async () => ({ data: [
    { id: 'actual.id', source: { type: 'package', target: 'fixture-package', PRIVATE_TOKEN: 'secret' }, state: { status: 'active' }, options: { token: 'secret' } },
    { id: 'internal', source: { type: 'builtin' }, state: { status: 'active' } },
    { id: 'unsafe', source: { type: 'package', target: 'https://user:secret@example.com/plugin' }, state: { status: 'failed', error: 'secret' } },
  ] }) };
  const result = await f.run('plugins');
  assert.equal(result.accepted, true);
  assert.deepEqual(result.plugins, [{ id: 'actual.id', source: { type: 'package', target: 'fixture-package' }, status: 'active' }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);

  f.api.client.skill = { list: async () => ({ data: [{ id: 'folder.ID', name: 'Friendly label', path: path.resolve('fixture/SKILL.md'), content: 'PRIVATE_CONTENT', token: 'PRIVATE_TOKEN' }] }) };
  assert.deepEqual((await f.run('skills')).skills, [{ id: 'folder.ID', name: 'Friendly label', path: path.resolve('fixture/SKILL.md') }]);
  f.api.client.skill = { list: async () => ({ data: [{ id: '*', name: 'Unsafe wildcard', path: path.resolve('fixture/SKILL.md') }] }) };
  assert.deepEqual((await f.run('skills')).skills, []);
  assert.deepEqual(f.controls, []);
});

test('V2 restores agent/model through native readback and refuses a nonempty draft', async () => {
  const f = fixture(), info = { agent: 'plan', model: { id: 'old', providerID: 'fixture' } };
  f.api.client.session.get = async () => info;
  f.api.client.session.switchAgent = async input => { info.agent = input.agent; };
  f.api.client.session.switchModel = async input => { info.model = input.model; };
  assert.equal((await handleV2Control(f.api, { id: 'agent', action: 'restore-agent', agent: 'build' }, f.state, 'launch')).accepted, true);
  assert.equal((await handleV2Control(f.api, { id: 'model', action: 'restore-model', providerID: 'fixture', modelID: 'new', variant: 'high' }, f.state, 'launch')).accepted, true);
  assert.deepEqual(info.model, { id: 'new', providerID: 'fixture', variant: 'high' });
  f.prompt.plainText = 'Keep this';
  assert.match((await handleV2Control(f.api, { id: 'blocked', action: 'restore-agent', agent: 'plan' }, f.state, 'launch')).error, /unavailable/);
  assert.equal(info.agent, 'build');
});

test('V2 native dispatch sends exactly one command; interruption never sends terminal keys', async () => {
  const f = fixture(); let input;
  f.api.client.session.fork = async value => { input = value; return { data: { id: 'ses_child', secret: 'never expose' } }; };
  const reply = await handleV2Control(f.api, { id: 'request', action: 'message-fork', before: 'msg_boundary' }, f.state, 'launch');
  assert.deepEqual(input, { sessionID: 'ses_owned', before: 'msg_boundary' });
  assert.deepEqual(reply, { id: 'request', accepted: true, nativeId: 'ses_child' });
  f.forms.push({}); const blocked = await f.run('message-fork'); assert.match(blocked.error, /dialogs/); f.forms.length = 0;
  assert.equal((await f.run('model')).accepted, true);
  assert.equal((await f.run('variant')).accepted, true);
  f.prompt.plainText = 'fixture draft';
  assert.equal((await f.run('submit')).accepted, true);
  assert.equal((await f.run('interrupt')).accepted, true);
  assert.deepEqual(f.controls, ['model.list', 'variant.list', 'prompt.submit', { sessionID: 'ses_owned' }]);
});

test('V2 prepare never overwrites drafts and controls refuse forms, busy chats, autocomplete and missing commands', async () => {
  const f = fixture(); f.prompt.plainText = 'PRIVATE_DRAFT';
  const draft = await f.run('prepare'); assert.match(draft.error, /empty native prompt/); assert.equal(JSON.stringify(draft).includes('PRIVATE_DRAFT'), false);
  f.prompt.plainText = ''; f.forms.push({}); assert.match((await f.run('model')).error, /dialogs/); f.forms.length = 0;
  f.permissions.push({}); assert.match((await f.run('submit')).error, /dialogs/); f.permissions.length = 0;
  f.api.data.session.status = () => 'running'; assert.match((await f.run('variant')).error, /idle/); f.api.data.session.status = () => 'idle';
  f.prompt.traits.capture.push('submit'); assert.match((await f.run('model')).error, /autocomplete/); f.prompt.traits.capture.pop();
  const commands = f.api.keymap.commands;
  f.api.keymap.commands = () => []; assert.match((await f.run('model')).error, /unavailable/);
  f.api.keymap.commands = commands;
  assert.deepEqual(f.controls, []);
  f.state.launchId = 'old'; assert.ok((await f.run('interrupt')).error); f.state.launchId = 'launch';
  f.api.ui.router.current = () => ({ type: 'session', sessionID: 'ses_foreign' }); assert.ok((await f.run('model')).error);
  f.api.ui.router.current = () => ({ type: 'session', sessionID: 'ses_owned' });
  let active = true; f.api.data.session.form.sync = async () => { active = false; };
  assert.ok((await f.run('model', () => active)).error); assert.deepEqual(f.controls, []);
});
test('V2 hot reload retains ephemeral request identity and never dispatches a request twice', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-control-'));
  const values = { MRMAK_OPENCODE_CONTROL: path.join(base, 'control'), MRMAK_OPENCODE_STATE: path.join(base, 'state'), MRMAK_OPENCODE_LAUNCH_ID: 'launch' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  let dispose;
  try {
    Object.assign(process.env, values);
    const f = fixture(), memory = { previous: null, busy: false };
    f.api.storage = { memory: () => [memory, mutation => mutation(memory)] };
    await writeFile(values.MRMAK_OPENCODE_STATE, JSON.stringify(f.state));
    await writeFile(values.MRMAK_OPENCODE_CONTROL, JSON.stringify({ id: 'once', action: 'model', launchId: 'launch', at: Date.now() }));
    dispose = await controlsPlugin.setup(f.api);
    const until = Date.now() + 2000;
    while (Date.now() < until && f.controls.length === 0) await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(f.controls, ['model.list']);
    assert.equal(JSON.parse(await readFile(`${values.MRMAK_OPENCODE_CONTROL}.reply`, 'utf8')).id, 'once');
    dispose(); dispose = await controlsPlugin.setup(f.api);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(f.controls, ['model.list']);
  } finally {
    dispose?.();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
