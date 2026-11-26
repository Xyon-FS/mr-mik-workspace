import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as toml } from 'smol-toml';
import { mkdtemp } from './fixtures.mjs';
import { managedBrowserDefinition, browserServerName } from '../managed-browser.mjs';
import { terminalCommand, claudeBridgeArgs, commandPath } from '../agents.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { openCodeRuntimeConfig } from '../opencode.mjs';
import { codexCommandFixture } from './cli-fixture.mjs';

test('browser launch is optional, isolated, pinned to local runtime and independent of native permissions', async t => {
  await codexCommandFixture(t);
  const outputDir = path.join(os.tmpdir(), 'browser-output-fixture');
  assert.equal(managedBrowserDefinition('off', { outputDir }), null);
  assert.throws(() => managedBrowserDefinition('personal', { outputDir }), /Choose/);
  const browser = managedBrowserDefinition('msedge', { outputDir, headless: true });
  assert.equal(browser.command, process.execPath);
  assert.ok(browser.args.includes('--isolated'));
  assert.ok(browser.args.includes('--headless'));
  assert.ok(!browser.args.some(arg => /npx|latest|user-data-dir|extension|cdp/.test(arg)));
  const args = terminalCommand('codex', { browser, codexPermissions: 'ask', bridge: { script: 'fixture-bridge' } }).args;
  assert.match(browser.serverName, /^mr_mik_playwright_[a-f0-9]{12}$/);
  assert.notEqual(managedBrowserDefinition('msedge', { outputDir }).serverName, browser.serverName);
  const override = args.find(arg => arg.startsWith(`mcp_servers.${browser.serverName}=`));
  assert.deepEqual({ ...toml(override).mcp_servers[browser.serverName] }, { command: browser.command, args: browser.args, enabled: true });
  assert.ok(args.includes('--sandbox'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(args.some(arg => arg.startsWith('mcp_servers.mrmak_workspace.command=')));
  assert.ok(!terminalCommand('codex').args.some(arg => arg.includes(browserServerName)));
  for (const script of [null, 'fixture-bridge']) {
    const config = JSON.parse(claudeBridgeArgs(script, browser)[1]);
    assert.deepEqual(config.mcpServers[browser.serverName], { type: 'stdio', command: browser.command, args: browser.args });
    assert.equal(!!config.mcpServers.mrmak_workspace, !!script);
  }
  for (const family of [1, 2]) {
    const config = openCodeRuntimeConfig({}, null, family, browser);
    const entry = family === 2 ? config.mcp.servers[browser.serverName] : config.mcp[browser.serverName];
    assert.deepEqual(entry.command, [browser.command, ...browser.args]);
    assert.equal(family === 2 ? entry.disabled : !entry.enabled, false);
  }
});

test('installed Codex accepts the managed browser table without inheriting conflicting fields', { skip: !commandPath('codex')?.endsWith('.exe'), timeout: 15000 }, async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-codex-'));
  const home = path.join(repo, 'profile'); await mkdir(home);
  const source = `[mcp_servers.${browserServerName}]\nurl="https://fixture.invalid/mcp"\n`;
  await writeFile(path.join(home, 'config.toml'), source);
  const browser = managedBrowserDefinition('msedge', { outputDir: path.join(repo, 'output') });
  const override = `mcp_servers.${browser.serverName}={command=${JSON.stringify(browser.command)},args=${JSON.stringify(browser.args)},enabled=true}`;
  const child = spawn(commandPath('codex'), ['app-server', '--stdio', '-c', override], { cwd: repo, env: { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const pending = new Map(); let sequence = 0;
  lines.on('line', line => { try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* Ignore non-protocol output. */ } });
  const rpc = async (method, params) => {
    const id = ++sequence; let timer;
    try { return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated browser config check timed out.')), 5000);
      pending.set(id, message => message.error ? reject(new Error('Codex rejected the isolated browser configuration.')) : resolve(message.result));
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }); } finally { clearTimeout(timer); pending.delete(id); }
  };
  try {
    await rpc('initialize', { clientInfo: { name: 'mik_browser_config_test', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await rpc('config/read', { cwd: repo });
    const effective = result.config.mcp_servers[browser.serverName];
    assert.deepEqual(effective.args, browser.args);
    assert.equal(effective.command, browser.command);
    assert.equal(effective.url, undefined);
    assert.equal(result.config.mcp_servers[browserServerName].url, 'https://fixture.invalid/mcp');
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), source);
  } finally { lines.close(); child.stdin.end(); child.kill(); await exited; }
});
