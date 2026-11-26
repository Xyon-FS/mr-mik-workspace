import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { nativeRefreshSnapshot } from '../native-refresh-snapshot.mjs';
import { ToolRefresh, changedMcps } from '../tool-refresh.mjs';

async function fixture(t, agent) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-native-refresh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), hub = path.join(base, 'hub'), root = path.join(base, 'project');
  for (const folder of [home, hub, root]) await mkdir(folder);
  await mkdir(path.join(root, '.git'));
  const prefix = agent === 'codex' ? '.agents' : agent === 'claude' ? '.claude' : '.opencode';
  const file = path.join(root, prefix, 'skills', 'fixture', 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '---\nname: fixture\ndescription: Fixture\n---\nPrivate instructions one.\n');
  const session = { id: 'chat', agent, cwd: root, openCodeFamily: 2, open: true, process: {}, activity: 'idle', nativeId: 'native', hasConversation: true };
  const snapshot = () => nativeRefreshSnapshot(session, hub, path.join(hub, '.mrmak'), { home, env: {} });
  return { root, hub, home, file, session, snapshot };
}

for (const agent of ['codex', 'claude', 'opencode']) test(`${agent}: native skill edits and opt-outs refresh privately, while disabled edits are inert`, async t => {
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

  const config = path.join(f.root, agent === 'codex' ? '.codex/config.toml' : agent === 'claude' ? '.claude/settings.local.json' : 'opencode.json');
  await mkdir(path.dirname(config), { recursive: true });
  const data = agent === 'codex' ? `[[skills.config]]\npath = ${JSON.stringify(f.file.replaceAll('\\', '/'))}\nenabled = false\n`
    : JSON.stringify(agent === 'claude' ? { skillOverrides: { fixture: 'off' } } : { permissions: [{ action: 'skill', resource: 'fixture', effect: 'deny' }] });
  let settings = data;
  if (agent === 'opencode') {
    const plugins = secret => [{ package: 'fixture-plugin', options: { secret } }];
    await writeFile(config, JSON.stringify({ plugins: plugins('private-one') }));
    const beforePluginEdit = await f.snapshot();
    await writeFile(config, JSON.stringify({ plugins: plugins('private-two') }));
    const afterPluginEdit = await f.snapshot();
    assert.ok(changedMcps(beforePluginEdit, afterPluginEdit).includes('native:plugin:declarations'));
    assert.equal(JSON.stringify(beforePluginEdit).includes('private-one'), false);
    settings = JSON.stringify({ ...JSON.parse(data), plugins: plugins('private-two') });
  }
  const beforeDisable = await f.snapshot();
  await writeFile(config, settings);
  const disabled = await f.snapshot();
  assert.equal(Object.values(disabled).find(row => row.kind === 'skill').enabled, false);
  assert.equal(changedMcps(beforeDisable, disabled).length, 1);
  await writeFile(f.file, '---\nname: fixture\n---\nChanged disabled instructions\n');
  assert.deepEqual(changedMcps(disabled, await f.snapshot()), []);
});

test('lean Codex snapshots skip Hub skill text and retain the native fingerprint size limit', async t => {
  const f = await fixture(t, 'codex'); f.session.chatInterface = 'chat';
  f.session.cwd = f.hub;
  const hubSkill = path.join(f.hub, '.agents/skills/hub-only/SKILL.md'); await mkdir(path.dirname(hubSkill), { recursive: true });
  await writeFile(hubSkill, 'x'.repeat(1024 * 1024 + 1));
  assert.deepEqual(await f.snapshot(), {});
  f.session.cwd = f.root; await writeFile(f.file, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(f.snapshot(), /fingerprinted safely/);
});

test('full and lean inventories agree on missing/managed plugins, version changes and project overrides', async t => {
  const f = await fixture(t, 'codex'), codexHome = path.join(f.home, '.codex'), cache = path.join(codexHome, 'plugins/cache/fixture/local');
  await mkdir(path.join(cache, '1.0'), { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), '[plugins."local@fixture"]\nenabled=true\n[plugins."missing@fixture"]\nenabled=true\n[plugins."browser@openai-bundled"]\nenabled=true\n');
  const compare = async () => {
    f.session.chatInterface = 'cli'; const full = await f.snapshot();
    f.session.chatInterface = 'chat'; const lean = await f.snapshot();
    assert.deepEqual(lean, full); return lean;
  };
  const initial = await compare();
  await mkdir(path.join(cache, '2.0')); const updated = await compare();
  assert.deepEqual(changedMcps(initial, updated), ['native:plugin:local@fixture']);
  const config = path.join(f.root, '.codex/config.toml'); await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '[plugins."local@fixture"]\nenabled=false\n'); const disabled = await compare();
  assert.deepEqual(changedMcps(updated, disabled), ['native:plugin:local@fixture']);
  assert.equal(disabled['native:plugin:local@fixture'].enabled, false);
  await mkdir(path.join(cache, '3.0')); assert.deepEqual(changedMcps(disabled, await compare()), []);
});
