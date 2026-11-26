import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createService, mkdtemp, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-source-'));
const home = path.join(repo, 'home');
const source = path.join(repo, 'Player.cs').replaceAll('\\', '/');
const href = process.platform === 'win32' ? `/${source}#L2C3` : `${source}#L2C3`;
const wires = [];
let service, browser;
try {
  await mkdir(path.join(repo, 'workspace')); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(source, 'class Player {\n  int Score;\n}\n');
  await writeFile(path.join(repo, 'notes.txt'), 'Ordinary notes.');
  service = await createService({ repo, uiDir: path.resolve(process.argv[2] || 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } } });
  service.sessions.verifyAccount = async () => {};
  service.sessions.verifyIdentity = async () => {};
  service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('File link fixture'), codex = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const wire = claudeFixture(options.session.nativeId); wires.push(wire);
    return new ClaudeChat({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 460, height: 800 } });
  const page = await context.newPage(), workspace = await context.newPage();
  await workspace.goto(service.urls.workspace);
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: agent, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    const turn = { id: 'source-turn', status: 'completed', timingSource: 'unavailable' };
    const text = agent === 'codex' ? `:codex-file-citation{path="${href}"}` : `[Player.cs](${href})`;
    const item = { id: 'source-answer', type: 'agentMessage', turnId: turn.id, text: text + '\n\n[Notes](notes.txt)', details: '', status: 'completed' };
    if (agent === 'codex') { runtime.items = new Map([[item.id, item]]); runtime.turns = new Map([[turn.id, turn]]); }
    else Object.assign(runtime.protocol.state, { items: [item], turns: [turn], status: 'ready' });
    runtime.changed();
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    await page.getByRole('link', { name: 'Notes', exact: true }).click();
    const preview = workspace.locator('.workspace-preview-slot:not([hidden]) .file-preview');
    await expect(preview.locator('pre')).toContainText('Ordinary notes.');
    const open = page.getByRole('button', { name: 'Open Player.cs', exact: true });
    await open.press('Enter');
    const menu = page.getByRole('dialog', { name: 'Open Player.cs', exact: true });
    await menu.getByRole('button', { name: 'Preview in Workspace' }).click();
    await expect(preview.locator('pre')).toContainText('int Score;');
    const endpoint = `**/api/sessions/${session.id}/chat`;
    await page.route(endpoint, route => {
      const request = route.request();
      if (request.method() !== 'POST' || request.postDataJSON()?.destination !== 'ide') return route.continue();
      return route.fulfill({ json: { requested: true, ide: 'Fixture' } });
    });
    await open.click();
    const sent = page.waitForRequest(request => request.url().endsWith(`/sessions/${session.id}/chat`) && request.method() === 'POST' && request.postDataJSON()?.destination === 'ide');
    await menu.getByRole('button', { name: 'Open in IDE' }).click();
    assert.equal((await sent).postDataJSON().href, href);
    await page.unroute(endpoint);
  }
  console.log('PASS Codex and Claude file links: Windows path, C# Workspace preview, direct text preview, keyboard menu and IDE destination.');
} finally { await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
