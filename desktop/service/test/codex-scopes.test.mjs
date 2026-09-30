import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse as toml } from 'smol-toml';
import { Projects } from '../projects.mjs';
import { CodexScopes } from '../codex-scopes.mjs';
import { effectiveCodex } from '../codex-effective.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { commandPath } from '../agents.mjs';
import { execFileSync } from 'node:child_process';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-codex-scopes-'));
  const hub = path.join(base, 'hub'), project = path.join(base, 'game'), home = path.join(base, 'home');
  for (const folder of [hub, project, path.join(home, '.codex'), path.join(home, '.agents/skills/unity-cli'), path.join(home, '.codex/plugins/cache/local/unity/1.0'), path.join(project, '.agents/skills/game')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(home, '.codex/config.toml'), '[plugins."unity@local"]\nenabled = false\n[mcp_servers.unityMCP]\ncommand = "uvx"\n');
  await writeFile(path.join(home, '.agents/skills/unity-cli/SKILL.md'), '---\nname: unity-cli\ndescription: Unity CLI\n---');
  await writeFile(path.join(project, '.agents/skills/game/SKILL.md'), '---\nname: game\ndescription: Project\n---');
  await mkdir(path.join(project, '.codex'));
  const config = path.join(project, '.codex/config.toml');
  await writeFile(config, '# user comment\nmodel_verbosity = "low"\n');
  const projects = new Projects(hub, path.join(hub, '.mrmak'));
  const registered = await projects.save({ name: 'Game', repositoryPath: project });
  return { base, hub, project, home, config, registered, scopes: new CodexScopes(projects, { home, env: { CODEX_HOME: path.join(home, '.codex') } }) };
}

test('Codex project toggles preserve foreign config, shared installation and personal defaults', async () => {
  const f = await fixture();
  const first = await f.scopes.list(f.registered.id);
  assert.ok(first.rows.some(item => item.kind === 'plugin' && item.id === 'unity@local' && item.installed && !item.globalEnabled));
  assert.ok(first.rows.some(item => item.kind === 'skill' && item.name === 'game' && item.source === 'Project folder'));
  const personal = first.rows.find(item => item.kind === 'skill' && item.name === 'unity-cli');
  await f.scopes.set(f.registered.id, { kind: 'plugin', id: 'unity@local', enabled: true });
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: false });
  await f.scopes.set(f.registered.id, { kind: 'skill', id: personal.id, enabled: false });
  const text = await readFile(f.config, 'utf8'), parsed = toml(text);
  assert.match(text, /# user comment/);
  assert.equal(parsed.plugins['unity@local'].enabled, true);
  assert.equal(parsed.mcp_servers.unityMCP.enabled, false);
  assert.equal(parsed.skills.config[0].enabled, false);
  assert.equal(await readFile(path.join(f.home, '.codex/config.toml'), 'utf8'), '[plugins."unity@local"]\nenabled = false\n[mcp_servers.unityMCP]\ncommand = "uvx"\n');
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: true });
  assert.equal(toml(await readFile(f.config, 'utf8')).mcp_servers.unityMCP.enabled, true);
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: null });
  assert.equal(toml(await readFile(f.config, 'utf8')).mcp_servers?.unityMCP, undefined);
});

test('Codex scope manager edits externally declared enablement without losing other fields', async () => {
  const f = await fixture();
  await writeFile(f.config, '# keep this comment\n[plugins."unity@local"]\nenabled = false # hand configured\n[mcp_servers.unityMCP]\nenabled = false # hand configured\ncommand = "uvx"\nargs = ["coplay"]\n');
  await f.scopes.set(f.registered.id, { kind: 'plugin', id: 'unity@local', enabled: true });
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: true });
  const projectText = await readFile(f.config, 'utf8');
  assert.equal((projectText.match(/enabled = true # hand configured/g) || []).length, 2);
  assert.match(projectText, /command = "uvx"/);
  assert.match(projectText, /# keep this comment/);
  await assert.rejects(f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: null }), /defines the component/);
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: false, scope: 'global' });
  assert.equal(toml(await readFile(path.join(f.home, '.codex/config.toml'), 'utf8')).mcp_servers.unityMCP.enabled, false);
  await f.scopes.set(f.registered.id, { kind: 'plugin', id: 'unity@local', enabled: true, scope: 'global' });
  assert.equal(toml(await readFile(path.join(f.home, '.codex/config.toml'), 'utf8')).plugins['unity@local'].enabled, true);
  await writeFile(f.config, '[broken');
  await assert.rejects(f.scopes.set(f.registered.id, { kind: 'plugin', id: 'unity@local', enabled: true }), /malformed/);
  assert.equal(await readFile(f.config, 'utf8'), '[broken');
});

test('installed Codex reads project plugin, skill and MCP overrides from a trusted repository', { skip: !commandPath('codex')?.endsWith('.exe'), timeout: 20000 }, async () => {
  const f = await fixture();
  execFileSync('git', ['init', '--quiet', f.project], { windowsHide: true });
  const trustedPath = f.project.replace(/ADMINI~1/i, 'Administrator');
  await writeFile(path.join(f.home, '.codex/config.toml'), `[projects.${JSON.stringify(trustedPath)}]\ntrust_level = "trusted"\n[plugins."unity@local"]\nenabled = false\n[mcp_servers.unityMCP]\ncommand = "uvx"\n`);
  await f.scopes.set(f.registered.id, { kind: 'plugin', id: 'unity@local', enabled: true });
  await f.scopes.set(f.registered.id, { kind: 'mcp', id: 'unityMCP', enabled: false });
  const personal = (await f.scopes.list(f.registered.id)).rows.find(item => item.kind === 'skill' && item.name === 'unity-cli');
  await f.scopes.set(f.registered.id, { kind: 'skill', id: personal.id, enabled: false });
  const child = spawn(commandPath('codex'), ['app-server', '--stdio'], { cwd: f.project, env: { ...process.env, CODEX_HOME: path.join(f.home, '.codex') }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* Ignore non-RPC output. */ } });
  const rpc = async (method, params) => {
    const id = ++sequence; let timer;
    try { return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated Codex config test timed out.')), 8000);
      pending.set(id, message => message.error ? reject(new Error(`Codex rejected the fixture configuration: ${message.error.message}`)) : resolve(message.result));
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }); } finally { clearTimeout(timer); pending.delete(id); }
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'mrmak_config_test', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await rpc('config/read', { cwd: f.project, includeLayers: true });
    assert.equal(result.config.plugins['unity@local'].enabled, true, JSON.stringify(result.config.plugins['unity@local']));
    assert.equal(result.config.mcp_servers.unityMCP.enabled, false);
    assert.equal(result.config.skills.config[0].enabled, false);
    const effective = await effectiveCodex(f.project, { ...process.env, CODEX_HOME: path.join(f.home, '.codex') });
    assert.equal(effective.plugins['unity@local'], true);
    assert.equal(effective.mcp.unityMCP, false);
    assert.equal(effective.skills[0].enabled, false);
    assert.equal(effective.projectLayerLoaded, true);
    assert.equal(JSON.stringify(effective).includes('uvx'), false);
  } finally { lines.close(); child.stdin.end(); child.kill(); }
});
