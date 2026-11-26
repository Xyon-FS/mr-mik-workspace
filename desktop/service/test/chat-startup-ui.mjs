// Production UI with deliberately held native preparation. No real login/model.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-startup-ui-'));
let service, browser, release = () => {};
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const uiDir = path.join(base, 'ui');
  await cp(path.resolve('dist'), uiDir, { recursive: true });
  await cp(path.resolve('public/assets'), path.join(uiDir, 'assets'), { recursive: true });
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Startup fixture'), codex = graphicalFixture(), claudes = [];
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {};
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const fixture = claudeFixture(options.session.nativeId); claudes.push(fixture); return new ClaudeChat({ ...options, transportFactory: fixture.factory });
  };
  const prepare = service.sessions.prepareLaunch;
  browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 650, height: 1050 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(service.urls.chats);
  for (const provider of ['Codex', 'Claude']) {
    let entered = false; const gate = new Promise(resolve => { release = resolve; });
    service.sessions.prepareLaunch = async (...args) => { entered = true; await gate; return prepare(...args); };
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const dialog = page.locator('form.desk-dialog');
    await dialog.locator('.agent-choice').filter({ hasText: provider === 'Codex' ? 'Codex' : 'Claude Code' }).click();
    if (provider === 'Codex') { await dialog.getByRole('combobox', { name: 'Codex account', exact: true }).click(); await page.getByRole('option', { name: 'Startup fixture', exact: true }).click(); }
    await dialog.getByRole('combobox', { name: 'Chat interface', exact: true }).click(); await page.getByRole('option', { name: 'Chat', exact: true }).click();
    const response = page.waitForResponse(result => result.url().endsWith('/api/sessions') && result.request().method() === 'POST');
    await page.evaluate(provider => {
      window.startupPaintMeasurement = new Promise(resolve => {
        document.querySelector('form.desk-dialog').addEventListener('submit', () => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (!document.querySelector(`[aria-label="${provider} starting chat"] textarea`)) return;
            observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
          }); observer.observe(document.body, { childList: true, subtree: true });
        }, { once: true });
      });
    }, provider);
    await dialog.getByRole('button', { name: 'Open chat', exact: true }).click();
    const created = await (await response).json();
    const starting = page.getByRole('region', { name: `${provider} starting chat`, exact: true }); await expect(starting).toBeVisible();
    await expect(starting.getByRole('status')).toContainText(`Preparing ${provider}`);await expect(page.locator('.chat-status')).not.toContainText(/Starting|Reconnecting/);
    console.log(`${provider} submit-to-editable-composer paint: ${Math.round(await page.evaluate(() => window.startupPaintMeasurement))}ms`);
    await expect.poll(() => entered).toBe(true);
    assert.equal(JSON.parse(await readFile(path.join(repo, '.mrmak/sessions.json'))).some(row => row.id === created.id), true);
    const draft = starting.getByRole('textbox', { name: `Message ${provider}`, exact: true });
    await draft.fill('Unsent startup draft'); await draft.press('Enter');
    await page.screenshot({ path: path.resolve(`.cache/startup-fix-starting-${provider.toLowerCase()}.png`) });
    await expect(starting.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    release();
    const ready = page.getByRole('region', { name: `${provider} graphical chat`, exact: true }); await expect(ready).toBeVisible();
    const input = ready.getByRole('textbox', { name: `Message ${provider}`, exact: true });
    await expect(input).toHaveValue('Unsent startup draft'); await expect(input).toBeFocused();
    await input.press('End'); await input.pressSequentially(' preserved'); await expect(input).toHaveValue('Unsent startup draft preserved');
    assert.equal(codex.calls.some(call => call.method === 'turn/start'), false);
    assert.equal(claudes.some(fixture => fixture.calls.some(call => call.type === 'user')), false);
    if (provider === 'Claude') {
      await page.setViewportSize({ width: 390, height: 850 });
      assert.equal(await ready.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    }
    await service.sessions.remove(created.id);
  }
  // A failed preflight remains retryable with the same ordinary local draft.
  const failure = new Promise(resolve => { release = resolve; });
  service.sessions.verifyAccount = async () => { await failure; throw new Error('Synthetic account unavailable'); };
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const dialog = page.locator('form.desk-dialog');
  await dialog.locator('.agent-choice').filter({ hasText: 'Claude Code' }).click();
  await dialog.getByRole('combobox', { name: 'Chat interface', exact: true }).click(); await page.getByRole('option', { name: 'Chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open chat', exact: true }).click();
  const starting = page.getByRole('region', { name: 'Claude starting chat', exact: true });
  await starting.getByRole('textbox', { name: 'Message Claude', exact: true }).fill('Retry this retained draft');
  release(); await expect(page.getByText('Synthetic account unavailable', { exact: true })).toBeVisible();
  service.sessions.verifyAccount = async () => {};
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Claude graphical chat', exact: true }).getByRole('textbox', { name: 'Message Claude', exact: true })).toHaveValue('Retry this retained draft');
  assert.equal(claudes.some(fixture => fixture.calls.some(call => call.type === 'user')), false);
  assert.deepEqual(errors, []);
  console.log('PASS immediate registered chat while native preparation is held; durable identity, editable retained draft, disabled send, focus/caret handoff, both providers and narrow layout. Zero model prompts.');
} finally { release(); await browser?.close(); await service?.close(); await cleanupFixtures(); }
