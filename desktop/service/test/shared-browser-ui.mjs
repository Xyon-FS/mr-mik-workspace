import { testBrowserEnvironment } from './fixtures.mjs';
// Real pinned browser MCP + production Workspace panel, isolated Hub/accounts.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const isClaude = process.argv.includes('--claude'), portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.resolve('desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(serviceRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shared-browser-ui-'));
let service, uiBrowser, client, transport, releaseBootstrap = () => {}, releaseConnect = () => {};
try {
  const uiDir = portableIndex < 0 ? path.join(root, 'ui') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
  if (portableIndex < 0) await build({ root: process.cwd(), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: false } });
  const repo = path.join(root, 'hub'), home = path.join(root, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(native, 'config.toml'), '# Synthetic\n');
  const nativeEvents = [];
  service = await createService({ repo, uiDir, native: event => nativeEvents.push(event), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(root, 'accounts') }, browserOptions: {
    launch: options => chromium.launch({ ...options, env: testBrowserEnvironment(), headless: true }),
    launchPersistent: (folder, options) => chromium.launchPersistentContext(folder, { ...options, env: testBrowserEnvironment(), headless: true }),
  } }, factory);
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const request = async (url, data) => { const response = await fetch(service.origin + url, { headers, method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  await request('/api/settings', { managedBrowser: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const profile = await service.profiles.create('Browser fixture'); service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  let claudeWire; const fixture = graphicalFixture(); service.sessions.createGraphicalRuntime = options => { if (isClaude) { claudeWire = claudeFixture(options.session.nativeId); return new ClaudeChat({ ...options, transportFactory: claudeWire.factory }); } return new CodexChat({ ...options, spawnChild: fixture.spawnChild }); };
  const session = await service.sessions.create({ agent: isClaude ? 'claude' : 'codex', chatInterface: 'chat', ...(isClaude ? {} : { accountProfileId: profile.id }), codexPermissions: 'ask', cwd: repo });
  const runtime = service.sessions.get(session.id).graphical, record = service.sharedBrowsers.get(session.id);
  assert.equal(runtime.snapshot().sharedBrowser, true);
  if (isClaude) assert.equal(runtime.snapshot().capabilities.browserPanel, true);
  assert.equal(record.browser, undefined, 'No browser before MCP discovery or explicit viewer open');
  assert.ok(!runtime.browser.args.some(argument => argument.includes(record.token)));
  const cli = service.sessions.prepareBrowser({ id: 'cli-fixture', agent: 'codex', chatInterface: 'cli' });
  const claudeCli = service.sessions.prepareBrowser({ id: 'claude-cli-fixture', agent: 'claude', chatInterface: 'cli' }); assert.equal(claudeCli.shared, undefined);
  const openCodeCli = service.sessions.prepareBrowser({ id: 'opencode-cli-fixture', agent: 'opencode', chatInterface: 'cli' }); assert.equal(openCodeCli.shared, undefined);
  assert.equal(cli.shared, undefined); assert.ok(cli.args.includes('--isolated')); assert.equal(cli.env, undefined);
  transport = new StdioClientTransport({ command: runtime.browser.command, args: runtime.browser.args, env: { ...process.env, ...runtime.browser.env }, stderr: 'ignore' });
  client = new Client({ name: 'browser-integration-fixture', version: '1' }); await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'browser_navigate')); assert.ok(!tools.some(tool => ['browser_run_code', 'browser_install'].includes(tool.name)));
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const file = path.join(repo, 'fixture.html');
  await writeFile(file, '<!doctype html><title>Shared fixture</title><style>body{font:20px system-ui;margin:20px}button,input{font:inherit;height:42px}button{width:200px}</style><h1>Workspace browser fixture</h1><button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);this.textContent=\'User changed page\'">Shared button</button><input aria-label="Shared input"><p><input type="file" aria-label="File field"></p><a download="proof.txt" href="data:text/plain,download-proof">Download proof</a><div style="height:1400px">Scroll content</div>');
  const fixtureUrl = service.files.url(file);
  uiBrowser = await chromium.launch({ env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'msedge', headless: true }); const uiContext = await uiBrowser.newContext(); const workspace = await uiContext.newPage(), chat = await uiContext.newPage();
  const errors = []; workspace.on('pageerror', error => errors.push(error.message)); chat.on('pageerror', error => errors.push(error.message));
  // Capture the initial state before the browser opens, then authenticate events
  // only afterwards: the open notification is intentionally missed.
  const bootstrapGate = new Promise(resolve => { releaseBootstrap = resolve; }); let captured = false;
  await workspace.route('**/api/bootstrap', async route => { const response = await route.fetch(); captured = true; await bootstrapGate; await route.fulfill({ response }); });
  await workspace.goto(service.urls.workspace); await chat.goto(service.urls.chats);
  await expect.poll(() => captured).toBe(true);
  const response = await call('browser_navigate', { url: fixtureUrl }); assert.ok(!response.isError, text(response));
  releaseBootstrap();
  assert.ok(nativeEvents.some(event => event.type === 'window' && event.window === 'workspace'));
  const panel = workspace.getByRole('region', { name: 'Workspace browser', exact: true }); await expect(panel).toBeVisible();
  await expect.poll(() => panel.locator('canvas').getAttribute('data-frames')).not.toBeNull();
  const page = record.context.pages()[0]; await expect(page.getByRole('heading')).toHaveText('Workspace browser fixture');
  const openOptions = async () => { if (!await panel.locator('details.preview-options').evaluate(el => el.open)) await panel.getByLabel('Browser options', { exact: true }).click(); };
  const option = async (label, value) => { await openOptions(); await panel.getByRole('combobox', { name: label, exact: true }).selectOption(value); await workspace.keyboard.press('Escape'); };
  assert.ok(await panel.locator('header').evaluate(el => el.getBoundingClientRect().height) <= 48, 'Primary controls use one compact row');
  await openOptions(); await workspace.keyboard.press('Shift+Tab'); await expect(panel.getByRole('button', { name: 'Take control', exact: true })).toBeFocused(); await expect(panel.locator('details.preview-options')).not.toHaveAttribute('open', '');
  await option('Browser display scale', '1'); await expect(panel.locator('canvas')).toHaveCSS('width', '1100px');
  await option('Browser display scale', '1.25'); await expect(panel.locator('canvas')).toHaveCSS('width', '1375px');
  await option('Browser display scale', 'fit'); await expect.poll(() => panel.locator('canvas').evaluate(el => el.getBoundingClientRect().width <= el.closest('.shared-browser-view').clientWidth+1)).toBe(true);
  await panel.getByRole('button', { name: 'Take control', exact: true }).click(); await expect.poll(() => record.owner).toBe('user');
  await page.evaluate(() => { location.hash = 'history-proof'; }); await expect(panel.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(fixtureUrl + '#history-proof');
  await panel.getByRole('button', { name: 'Go back', exact: true }).click(); await expect.poll(() => page.url()).toBe(fixtureUrl);
  await panel.getByRole('button', { name: 'Go forward', exact: true }).click(); await expect.poll(() => page.url()).toBe(fixtureUrl + '#history-proof');
  await panel.getByRole('button', { name: 'Go back', exact: true }).click(); await expect.poll(() => page.url()).toBe(fixtureUrl);
  await panel.locator('canvas').focus(); await workspace.keyboard.press('Control+l'); await expect(panel.getByRole('textbox', { name: 'Browser address', exact: true })).toBeFocused();
  const blocked = await call('browser_evaluate', { function: "() => { document.title='should not run'; }" }); assert.equal(blocked.isError, true); assert.match(text(blocked), /user controls/);
  const click = async locator => { const target = await locator.boundingBox(), surface = await panel.locator('canvas').boundingBox(); await panel.locator('canvas').click({ position: { x: (target.x + target.width / 2) * surface.width / (record.viewport?.width || 1100), y: (target.y + target.height / 2) * surface.height / (record.viewport?.height || 720) } }); };
  await click(page.getByRole('button', { name: 'Shared button', exact: true })); await expect(page.getByRole('button', { name: 'User changed page', exact: true })).toBeVisible();
  await option('Browser display scale', '1.25'); await expect(panel.locator('canvas')).toHaveCSS('width', '1375px'); await click(page.getByRole('button', { name: 'User changed page', exact: true })); await expect(page.getByRole('button', { name: 'User changed page', exact: true })).toHaveAttribute('data-clicks', '2'); await option('Browser display scale', 'fit');
  await workspace.screenshot({ path: path.join(process.cwd(), `.cache/${isClaude ? 'claude' : 'codex'}-browser-display.png`) });
  await click(page.getByRole('textbox')); await workspace.keyboard.type('hello'); await expect(page.getByRole('textbox')).toHaveValue('hello');
  await panel.locator('canvas').hover(); await workspace.mouse.wheel(0, 150); await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await workspace.mouse.wheel(0, -150); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await panel.getByRole('button', { name: 'Return to agent', exact: true }).click(); await expect.poll(() => record.owner).toBe('agent');
  assert.match(text(await call('browser_snapshot')), /User changed page/);
  const evidenceIndex = process.argv.indexOf('--evidence');
  if (evidenceIndex !== -1) await panel.screenshot({ path: path.resolve(process.argv[evidenceIndex + 1]) });
  const fileScheme = await call('browser_navigate', { url: 'file:///C:/private.txt' }); assert.equal(fileScheme.isError, true);
  const forbiddenTool = await call('browser_run_code', { code: '() => process.env' }); assert.equal(forbiddenTool.isError, true);
  const authFile = path.join(repo, 'auth.json'); await writeFile(authFile, '{"synthetic":"private"}');
  await assert.rejects(service.sharedBrowsers.checkedUpload(record, authFile), /non-sensitive/);
  assert.equal((await fetch(`${service.origin}/api/browser/${session.id}`)).status, 401);
  assert.equal((await fetch(`${service.origin}/shared-browser`, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{"action":"tools"}' })).status, 403);
  const invalid = new WebSocket(`${service.origin.replace('http:', 'ws:')}/browser-stream`, { origin: service.origin });
  try { await new Promise((resolve, reject) => { invalid.on('error', reject); invalid.on('open', () => invalid.send(JSON.stringify({ type: 'auth', sessionId: session.id, ticket: 'wrong' }))); invalid.on('close', resolve); }); } finally { invalid.terminate(); }
  // Closing/reopening only detaches the viewer. It must not close or reset MCP.
  await panel.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => record.owner).toBe('user');
  await panel.getByRole('button', { name: 'Close browser panel', exact: true }).click(); await expect(panel).toHaveCount(0);
  await expect.poll(() => record.owner).toBe('agent');
  assert.equal(record.context.pages()[0], page); assert.match(text(await call('browser_snapshot')), /hello/);
  await chat.getByLabel('Chat details', { exact: true }).click(); await chat.getByRole('tab', { name: 'Session', exact: true }).click(); await chat.getByRole('button', { name: 'Open browser controls', exact: true }).click(); await expect(panel).toBeVisible(); await expect.poll(() => record.viewers.size).toBe(1);
  await workspace.reload(); await expect(panel).toBeVisible(); await expect.poll(() => record.viewers.size).toBe(1); await expect(page.getByRole('textbox')).toHaveValue('hello');
  // Real viewport changes reflow the same page; display scaling stays separate.
  await panel.getByRole('button', { name: 'Take control', exact: true }).click(); await expect.poll(() => record.owner).toBe('user');
  await option('Browser viewport', '390x844'); await expect.poll(() => page.viewportSize()?.width).toBe(390); assert.equal(await page.evaluate(() => matchMedia('(max-width:500px)').matches), true);
  await expect(panel.locator('canvas')).toHaveAttribute('width', '390'); await click(page.getByRole('button', { name: 'User changed page', exact: true })); await expect(page.getByRole('button', { name: 'User changed page', exact: true })).toHaveAttribute('data-clicks', '3');
  await page.getByRole('heading').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await openOptions(); await panel.getByRole('button', { name: 'Send selection to chat', exact: true }).click(); await expect.poll(() => runtime.composer.items.some(item => item.sourceUrl && item.text.includes('Workspace browser fixture'))).toBe(true);
  await expect(panel.getByLabel('Browser options', { exact: true })).toBeFocused();
  await chat.locator('.graphical-context-chip summary').last().click(); const note = chat.getByRole('textbox', { name: 'Browser note', exact: true }); await note.fill('Edited browser note'); await chat.getByRole('textbox', { name: isClaude ? 'Message Claude' : 'Message Codex', exact: true }).click(); await expect.poll(() => runtime.composer.items.some(item => item.text === 'Edited browser note')).toBe(true);
  await option('Browser viewport', '1100x720'); await expect.poll(() => page.viewportSize()?.width).toBe(1100); await expect(page.getByRole('textbox', { name: 'Shared input' })).toHaveValue('hello');
  const beforeHideScroll = await page.evaluate(() => scrollY);
  // Queue a wheel and leave in the same task, before the 45ms batch can fire.
  await workspace.evaluate(() => { document.querySelector('[aria-label="Workspace browser"] canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true })); document.querySelector('button[aria-label="Workspace home"]').click(); });
  await expect.poll(() => record.owner).toBe('agent'); assert.equal(await page.evaluate(() => scrollY), beforeHideScroll, 'A hidden viewer does not deliver a stale wheel');
  const connectGate = new Promise(resolve => { releaseConnect = resolve; }); let connectPaused = false;
  const browserRoute = `**/api/browser/${session.id}`;
  await workspace.route(browserRoute, async route => { if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'connect') { connectPaused = true; await connectGate; } await route.continue(); });
  await workspace.getByRole('tab', { name: session.name, exact: true }).click(); await expect(panel).toBeVisible(); await expect.poll(() => connectPaused).toBe(true);
  await expect(panel.getByRole('button', { name: 'Go back', exact: true })).toBeDisabled(); await expect(panel.getByRole('button', { name: 'Take control', exact: true })).toBeDisabled();
  releaseConnect(); await expect(panel.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled(); await workspace.unroute(browserRoute); assert.equal(record.context.pages()[0], page);
  await panel.getByRole('button', { name: 'Take control', exact: true }).click(); await expect.poll(() => record.owner).toBe('user');
  await panel.locator('canvas').hover(); await workspace.mouse.wheel(0, 150); await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeHideScroll);
  await workspace.mouse.wheel(0, -150); await expect.poll(() => page.evaluate(() => scrollY)).toBe(beforeHideScroll);
  await panel.getByRole('button', { name: 'Return to agent', exact: true }).click(); await expect.poll(() => record.owner).toBe('agent');
  const probe = { id: 'navigation-probe', type: 'agentMessage', text: '```typescript\nconst pinnedView = true;\n```', status: 'completed', details: '', turnId: 'probe-turn' };
  if (isClaude) runtime.protocol.state.items.push(probe); else runtime.items.set(probe.id, probe); runtime.changed();
  await chat.getByRole('button', { name: 'Open code in Workspace', exact: true }).last().click(); await workspace.getByRole('button', { name: 'Pin typescript preview', exact: true }).click();
  service.sharedBrowsers.onOpen(session.id); await expect(workspace.getByRole('tab', { name: 'typescript preview', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(workspace.getByRole('tab', { name: session.name, exact: true })).toHaveAttribute('aria-selected', 'false'); await workspace.getByRole('tab', { name: session.name, exact: true }).click(); await expect(panel).toBeVisible();
  // Manual file chooser, bounded transfer and download retrieval use API auth.
  await panel.getByRole('button', { name: 'Take control', exact: true }).click(); await expect.poll(() => record.owner).toBe('user');
  await click(page.getByLabel('File field')); await expect(panel.getByLabel('Upload file to browser')).toBeVisible();
  await panel.getByLabel('Upload file to browser').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('upload-proof') });
  await expect.poll(() => page.getByLabel('File field').evaluate(input => input.files[0]?.name)).toBe('upload.txt');
  await click(page.getByRole('link', { name: 'Download proof' })); await expect.poll(() => record.downloads.size).toBe(1);
  const downloadId = [...record.downloads.keys()][0], download = await fetch(`${service.origin}/api/browser/${session.id}/download/${downloadId}`, { headers }); assert.equal(await download.text(), 'download-proof');
  const pagesBefore = record.pages.size;
  await panel.getByRole('button', { name: 'New browser page', exact: true }).click(); await expect.poll(() => record.pages.size).toBe(pagesBefore + 1);
  const pageTabs = panel.getByRole('tablist', { name: 'Browser pages', exact: true }).getByRole('tab');
  await expect(pageTabs).toHaveCount(pagesBefore + 1); await expect(panel.getByRole('region', { name: 'Empty browser page', exact: true })).toContainText('Enter a URL');
  await expect(panel.getByRole('button', { name: 'New browser page', exact: true })).toBeEnabled(); await pageTabs.last().focus(); await workspace.keyboard.press('Home'); await expect(pageTabs.first()).toHaveAttribute('aria-selected', 'true'); await expect(pageTabs.first()).toBeFocused();
  await expect(panel.getByRole('button', { name: 'New browser page', exact: true })).toBeEnabled(); await workspace.keyboard.press('End'); await expect(pageTabs.last()).toHaveAttribute('aria-selected', 'true'); await expect(pageTabs.last()).toBeFocused();
  await expect(panel.getByRole('button', { name: 'New browser page', exact: true })).toBeEnabled(); await workspace.keyboard.press('ArrowLeft'); await expect(pageTabs.nth(pagesBefore - 1)).toHaveAttribute('aria-selected', 'true'); await expect(pageTabs.nth(pagesBefore - 1)).toBeFocused();
  await expect(panel.getByRole('button', { name: 'New browser page', exact: true })).toBeEnabled(); await workspace.keyboard.press('ArrowRight'); await expect(pageTabs.last()).toHaveAttribute('aria-selected', 'true'); await expect(pageTabs.last()).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Close browser page', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Close browser page', exact: true }).click(); await expect.poll(() => record.pages.size).toBe(pagesBefore);
  const originalId = [...record.pages].find(([, candidate]) => candidate === page)[0];
  await request(`/api/browser/${session.id}`, { action: 'select', pageId: originalId });
  await page.evaluate(() => { setTimeout(() => alert('Fixture confirmation'), 0); });
  await expect(panel.getByRole('dialog', { name: 'Browser page dialog' })).toContainText('Fixture confirmation');
  await panel.getByRole('button', { name: 'Dismiss dialog', exact: true }).click(); await expect(panel.getByRole('dialog')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Return to agent', exact: true }).click();
  await expect.poll(() => record.owner).toBe('agent'); assert.match(text(await call('browser_snapshot')), /Workspace browser fixture/);
  let finish;
  const held = service.sharedBrowsers.run(record, 'agent', () => new Promise(resolve => { finish = resolve; }));
  try { await assert.rejects(service.sharedBrowsers.action(record, { action: 'owner', owner: 'user' }), /Wait for/); }
  finally { finish(); await held; }
  await panel.getByRole('button', { name: 'Take control', exact: true }).click(); await expect.poll(() => record.owner).toBe('user');
  await panel.getByRole('textbox', { name: 'Browser address', exact: true }).fill(fixtureUrl + '#manual');
  await panel.getByRole('textbox', { name: 'Browser address', exact: true }).press('Enter');
  await expect.poll(() => page.url()).toBe(fixtureUrl + '#manual');
  await expect(panel.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(fixtureUrl + '#manual');
  await panel.getByRole('button', { name: 'Return to agent', exact: true }).click();
  await request('/api/browser-settings', { scope: 'chat', sessionId: session.id, choice: 'off' });
  assert.equal(record.channel, 'off'); assert.equal(record.browser, null);
  const offState = await request(`/api/browser/${session.id}`, { action: 'connect' }); assert.equal(offState.channel, 'off'); assert.equal(offState.ticket, undefined);
  await expect(panel.getByRole('region', { name: 'Browser disabled', exact: true })).toBeVisible();
  await panel.getByRole('combobox', { name: 'Enable chat browser', exact: true }).selectOption(process.env.MRMAK_TEST_BROWSER || 'msedge');
  await panel.getByRole('button', { name: 'Enable for this chat', exact: true }).click(); await expect.poll(() => record.status).toBe('ready');
  if (!await chat.locator('details.graphical-details').evaluate(element => element.open)) await chat.getByLabel('Chat details', { exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Open browser controls', exact: true })).toBeVisible();
  // Crash is visible and requires explicit restart; no tool action is replayed.
  await record.browser.close(); await expect(panel.getByRole('button', { name: 'Restart browser' })).toBeVisible();
  workspace.once('dialog', dialog => dialog.accept()); await panel.getByRole('button', { name: 'Restart browser' }).click();
  await expect.poll(() => record.status).toBe('ready'); await expect.poll(() => record.pages.size).toBe(1); assert.equal(record.downloads.size, 0);
  for (const width of [320, 460, 1280]) {
    await workspace.setViewportSize({ width, height: 800 }); await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const panelWidth = await panel.evaluate(el => el.clientWidth); assert.ok(await panel.locator('header').evaluate(el => el.getBoundingClientRect().height) <= (panelWidth <= 420 ? 82 : 48), 'Compact navigation reserves a full address row in narrow panels');
    await openOptions(); await expect(panel.getByRole('combobox', { name: 'Browser viewport', exact: true })).toBeVisible(); await workspace.keyboard.press('Escape');
    await workspace.screenshot({ path: path.join(process.cwd(), `.cache/${isClaude ? 'claude' : 'codex'}-browser-chrome-${width}.png`) });
  }
  assert.deepEqual(errors, []); if (isClaude) assert.equal(claudeWire.calls.filter(call => call.type === 'user').length, 0); assert.ok(!fixture.calls.some(call => ['turn/start', 'turn/steer'].includes(call.method)));
  await client.close(); client = null; await transport.close(); transport = null;
  service.sessions.stop(session.id); await expect.poll(() => service.sharedBrowsers.records.has(session.id)).toBe(false);
  await service.sharedBrowsers.close();
  assert.ok(!(await readdir(path.join(repo, '.mrmak'))).some(name => name.startsWith('shared-browser-')), 'Owned runtime folders are removed');
  console.log('PASS: production shared-browser proxy and Workspace UI, same-page control, CLI isolation, auth/tool/file boundaries, transfers, reconnect, explicit crash restart, narrow layout and chat cleanup. No model/login calls.');
} finally {
  releaseBootstrap();
  releaseConnect();
  await client?.close(); await transport?.close(); await uiBrowser?.close(); await service?.close(); await cleanupFixtures();
}
