// Production UI, isolated native profile directories, simulated native login/wire.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const root = path.resolve('.'), index = process.argv.indexOf('--portable'), portable = index < 0 ? null : path.resolve(process.argv[index + 1]);
const runtimeRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service'), uiDir = portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs'))), { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-profiles-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const env = { ...process.env, HOME: home, USERPROFILE: home }; delete env.CLAUDE_CONFIG_DIR;
  service = await createService({ repo, uiDir, mcpOptions: { home, env }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  const signedIn = new Set(['system']);
  service.claudeProfiles.identity = async env => ({ status: signedIn.has(env.CLAUDE_CONFIG_DIR || 'system') ? 'logged-in' : 'logged-out', identity: env.CLAUDE_CONFIG_DIR || 'system', email: env.CLAUDE_CONFIG_DIR ? 'work@example.test' : 'current@example.test' });
  const commands = [], launches = [];
  service.accounts.launch = async (command, env, options) => { assert.equal(options.silent, true); commands.push({ command, env }); signedIn.add(env.CLAUDE_CONFIG_DIR); return { requested: true, completed: true }; };
  service.sessions.captureTools = async () => ({}); service.sessions.prepareLaunch = async () => null; service.sessions.prepareBrowser = async () => null;
  service.sessions.createGraphicalRuntime = options => { const wire = claudeFixture(options.session.nativeId); launches.push({ options, wire }); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }), page = await context.newPage(), chats = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); chats.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace); await page.getByRole('button', { name: 'Toggle settings' }).click();
  const settings = page.getByRole('region', { name: 'Claude account profiles', exact: true });
  await expect(settings).toContainText('Claude · current account'); await settings.getByRole('button', { name: 'Add Claude account', exact: true }).click();
  await settings.getByLabel('Claude account name', { exact: true }).fill('Work Claude'); await settings.getByRole('button', { name: 'Create and sign in', exact: true }).click();
  await expect(settings).toContainText('Claude account connected.'); assert.equal(commands.length, 1);
  const row = (await service.claudeProfiles.list()).find(row => !row.system), profile = await service.claudeProfiles.context(row.id);
  assert.equal(commands[0].env.CLAUDE_CONFIG_DIR, profile.directory); assert.equal(commands[0].env.HOME, home); assert.deepEqual(await readdir(profile.directory), []);
  await page.screenshot({ path: path.join(root, '.cache/stage8-accounts.png') });
  await chats.goto(service.urls.chats); await chats.getByRole('button', { name: 'Open your first chat', exact: true }).click();
  await chats.getByRole('button', { name: 'Claude Code Your subscription', exact: true }).click();
  await chats.getByRole('combobox', { name: 'Claude account', exact: true }).click(); await chats.getByRole('option', { name: 'Work Claude', exact: true }).click();
  await chats.getByRole('combobox', { name: 'Chat interface', exact: true }).click(); await chats.getByRole('option', { name: 'Chat', exact: true }).click();
  await chats.getByRole('button', { name: 'Open chat', exact: true }).click(); await expect.poll(() => launches.length).toBe(1);
  const graphical = chats.getByRole('region', { name: 'Claude graphical chat', exact: true });
  await graphical.getByRole('textbox', { name: 'Message Claude', exact: true }).fill('Synthetic profile input'); await graphical.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(graphical).toContainText('Synthetic Claude answer.'); assert.equal(launches[0].options.env.CLAUDE_CONFIG_DIR, profile.directory);
  await graphical.getByLabel('Chat details', { exact: true }).click(); await expect(graphical.getByRole('region', { name: 'Session', exact: true })).toContainText('Work Claude');
  await page.getByRole('button', { name: 'Toggle settings' }).click(); await page.getByRole('button', { name: 'Toggle mcp' }).click();
  await expect(page.getByRole('combobox', { name: 'Claude account', exact: true })).toHaveCount(0);

  assert.equal(launches.flatMap(item => item.wire.calls).filter(call => call.type === 'user').length, 1); assert.deepEqual(errors, []);
  console.log('PASS Claude profiles production UI: current native profile, empty independent account creation, scoped native login, chat selection/send, pinned account details and Tools selector. No real authentication or inference.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
