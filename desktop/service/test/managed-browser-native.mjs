// Opt-in local MCP acceptance. No model turn, login, personal browser or real Hub.
// --runtime must contain the pinned @playwright/mcp service dependency.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { managedBrowserDefinition } from '../managed-browser.mjs';
import { within } from '../util.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

async function browserChildPids(parent) {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(parent)}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000 });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(value) ? value : [value];
}
async function waitExited(pids) {
  const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!pids.some(alive), 'Closing the MCP transport must close its browser process');
}

const option = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--runtime')) throw new Error('Pass --runtime with an isolated installed service dependency directory.');
const runtime = path.resolve(option('--runtime'));
const require = createRequire(path.join(runtime, 'package.json'));
const pkgFile = require.resolve('@playwright/mcp/package.json');
assert.equal(JSON.parse(await readFile(pkgFile, 'utf8')).version, '0.0.83');
const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-native-'));
// Copy runtime modules into the fixture so the entry's package resolution uses
// only this test's dependency tree, never global CLI/browser configuration.
const modules = path.join(repo, 'node_modules');
await cp(path.join(runtime, 'node_modules'), modules, { recursive: true });
for (const name of ['managed-browser.mjs', 'managed-browser-entry.mjs']) await cp(fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(repo, name));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await writeFile(path.join(repo, 'ui/index.html'), '<html>Fixture</html>');
const service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: path.join(repo, 'native-home'), env: {} } });
const clients = [], transports = [];
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result.content).slice(0, 400)}`);
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
};
const snapshotText = async text => {
  const link = /\[Snapshot\]\(([^)]+)\)/.exec(text)?.[1];
  if (!link) return text;
  const file = path.resolve(repo, link);
  assert.ok(within(repo, file), 'Snapshot must stay in the isolated fixture');
  return await readFile(file, 'utf8');
};
try {
  const card = await service.projects.createCard({ title: 'Browser MCP fixture' });
  const grant = service.bridge.issue('browser-test', null, card.id);
  const dest = await service.bridge.call(grant, 'mrmak_hub_destination', { kind: 'card', title: 'Browser fixture' });
  await writeFile(dest.path, '<!doctype html><html><body><h1>Managed browser fixture</h1><button onclick="this.textContent=\'Verified\'">Check interaction</button></body></html>');
  const { previewUrl } = await service.bridge.call(grant, 'mrmak_register_hub_file', { destinationId: dest.destinationId });
  for (let index = 0; index < 2; index++) {
    const browser = managedBrowserDefinition('msedge', { outputDir: path.join(repo, 'output', String(index)), headless: true });
    browser.args[0] = path.join(repo, 'managed-browser-entry.mjs');
    const transport = new StdioClientTransport({ ...browser, cwd: repo, stderr: 'ignore', env: { ...process.env,
      // The wrapper must ignore ambient state/remote-browser configuration.
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:1', PLAYWRIGHT_MCP_STORAGE_STATE: 'missing-private-state.json' } });
    const client = new Client({ name: 'mik-browser-acceptance', version: '1' }, { capabilities: {} });
    clients.push(client); transports.push(transport);
    await client.connect(transport, { timeout: 15000 });
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'browser_navigate'));
    assert.match(await snapshotText(await call(client, 'browser_navigate', { url: previewUrl })), /Managed browser fixture/);
  }
  const first = clients[0], second = clients[1];
  await call(first, 'browser_evaluate', { function: "() => { localStorage.setItem('fixture-private', 'first-only'); return true; }" });
  assert.match(await call(second, 'browser_evaluate', { function: "() => localStorage.getItem('fixture-private')" }), /null/);
  const snapshot = await snapshotText(await call(first, 'browser_snapshot'));
  const ref = /button "Check interaction" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
  assert.ok(ref, 'Fixture button must have a native MCP reference');
  assert.match(await snapshotText(await call(first, 'browser_click', { target: ref, element: 'Check interaction button' })), /Verified/);
  const shot = await first.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png', filename: 'fixture.png', scale: 'css' } });
  assert.ok(!shot.isError);
  assert.ok((await readFile(path.join(repo, 'fixture.png'))).length > 100);
  const owned = await browserChildPids(transports[0].pid);
  if (process.platform === 'win32') assert.ok(owned.length, 'MCP must own its separate browser process');
  // Exercise CLI-style disconnect while the browser is open, not only the
  // explicit browser_close tool. The other session must remain usable.
  await first.close();
  await waitExited(owned);
  assert.match(await snapshotText(await call(second, 'browser_snapshot')), /Check interaction/);
  await call(second, 'browser_close');
  console.log('PASS: pinned MCP navigates a scoped card, clicks, screenshots, isolates two sessions and closes each independently. No model or personal browser was used.');
} finally {
  for (const client of clients) {
    await client.callTool({ name: 'browser_close', arguments: {} }, undefined, { timeout: 5000 }).catch(() => {});
    await client.close().catch(() => {});
  }
  for (const transport of transports) await transport.close().catch(() => {});
  await service.close();
  await cleanupFixtures();
}
