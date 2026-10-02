import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { nativeRefreshSnapshot } from '../native-refresh-snapshot.mjs';
import { ToolRefresh, changedMcps } from '../tool-refresh.mjs';

async function fixture(t, agent) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-native-refresh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), hub = path.join(base, 'hub'), root = path.join(base, 'project');
  for (const folder of [home, hub, root]) await mkdir(folder);
  const prefix = agent === 'codex' ? '.agents' : agent === 'claude' ? '.claude' : '.opencode';
  const file = path.join(root, prefix, 'skills', 'fixture', 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '---\nname: fixture\ndescription: Fixture\n---\nPrivate instructions one.\n');
  const session = { id: 'chat', agent, cwd: root, openCodeFamily: 2, open: true, process: {}, activity: 'idle', nativeId: 'native', hasConversation: true };
  const snapshot = () => nativeRefreshSnapshot(session, hub, path.join(hub, '.mrmak'), { home, env: {} });
  return { root, hub, file, session, snapshot };
}

for (const agent of ['codex', 'claude', 'opencode']) test(`${agent}: active project skills are fingerprinted privately and never treated as live MCP changes`, async t => {
  const f = await fixture(t, agent), before = await f.snapshot();
  assert.equal(Object.values(before).find(row => row.kind === 'skill')?.enabled, true);
  assert.equal(JSON.stringify(before).includes('Private instructions'), false);
  await writeFile(f.file, '---\nname: fixture\ndescription: Fixture\n---\nPrivate instructions two.\n');
  const after = await f.snapshot();
  assert.equal(changedMcps(before, after).length, 1);
  let restarts = 0;
  const sessions = { items: new Map([[f.session.id, f.session]]), get: () => f.session, changed() {} };
  const refresh = new ToolRefresh(sessions, { snapshot: f.snapshot, ready: async () => true, live: async () => assert.fail('Skill is not an MCP'), restart: async () => { restarts++; refresh.launched(f.session, after); }, delay: 60000 });
  t.after(() => refresh.close()); refresh.launched(f.session, before);
  await refresh.scan(); await refresh.poll(); assert.equal(restarts, 1);
  assert.equal(f.session.nativeId, 'native');
});

test('OpenCode plugin options are hashed without retaining option values', async t => {
  const f = await fixture(t, 'opencode'), config = path.join(f.root, 'opencode.json');
  await writeFile(config, JSON.stringify({ plugins: [{ package: 'fixture-plugin', options: { secret: 'private-one' } }] }));
  const before = await f.snapshot();
  await writeFile(config, JSON.stringify({ plugins: [{ package: 'fixture-plugin', options: { secret: 'private-two' } }] }));
  const after = await f.snapshot();
  assert.ok(changedMcps(before, after).includes('native:plugin:declarations'));
  assert.equal(JSON.stringify(before).includes('private-one'), false);
});

test('OpenCode V2 skill approval changes participate in guarded refresh', async t => {
  const f = await fixture(t, 'opencode'), config = path.join(f.root, 'opencode.json');
  await writeFile(config, JSON.stringify({ permissions: [{ action: 'skill', resource: 'fixture', effect: 'ask' }] }));
  const before = await f.snapshot();
  await writeFile(config, JSON.stringify({ permissions: [{ action: 'skill', resource: 'fixture', effect: 'allow' }] }));
  const after = await f.snapshot();
  assert.equal(changedMcps(before, after).length, 1);
});

test('Hub Bridge skills do not participate in native refresh', async t => {
  const f = await fixture(t, 'codex'); f.session.cwd = f.hub;
  const file = path.join(f.hub, '.agents/skills/hub-only/SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '---\nname: hub-only\n---\nHub instructions\n');
  assert.deepEqual(await f.snapshot(), {});
});

for (const agent of ['codex', 'claude', 'opencode']) test(`${agent}: disabling a native skill changes availability; editing an already disabled skill is a no-op`, async t => {
  const f = await fixture(t, agent), before = await f.snapshot();
  const config = path.join(f.root, agent === 'codex' ? '.codex/config.toml' : agent === 'claude' ? '.claude/settings.local.json' : 'opencode.json');
  await mkdir(path.dirname(config), { recursive: true });
  const data = agent === 'codex' ? `[[skills.config]]\npath = ${JSON.stringify(f.file.replaceAll('\\', '/'))}\nenabled = false\n`
    : JSON.stringify(agent === 'claude' ? { skillOverrides: { fixture: 'off' } } : { permissions: [{ action: 'skill', resource: 'fixture', effect: 'deny' }] });
  await writeFile(config, data);
  const disabled = await f.snapshot();
  assert.equal(Object.values(disabled).find(row => row.kind === 'skill').enabled, false);
  assert.equal(changedMcps(before, disabled).length, 1);
  await writeFile(f.file, '---\nname: fixture\n---\nChanged disabled instructions\n');
  assert.deepEqual(changedMcps(disabled, await f.snapshot()), []);
});
