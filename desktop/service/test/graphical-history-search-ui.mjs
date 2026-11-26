import { testBrowserEnvironment } from './fixtures.mjs';
// Whole-conversation search/navigation; native history and accounts are fixtures.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-search-ui-'));
let service, browser, releasePaused;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(native, 'config.toml'), '# Synthetic\n');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Search fixture');
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const transport = graphicalFixture(); service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, codexPermissions: 'ask', cwd: repo }), r = service.sessions.get(session.id).graphical;
  const all = Array.from({ length: 600 }, (_, index) => ({ id: `item-${index}`, type: 'agentMessage', text: index === 20 ? 'Ancient unique target' : `Saved message ${index}`, status: 'completed' }));
  Object.assign(all[20],{turnId:'hidden-progress',phase:'commentary'});Object.assign(all[21],{turnId:'hidden-progress',phase:'final_answer'});
  for (const item of all) r.upsert(item);
  await r.composer.add({ type: 'quote', itemId: 'item-580', text: 'Saved message 580' });
  const reference = path.join(repo, 'reference.txt'); await writeFile(reference, 'Synthetic'); r.attachments = [reference]; r.historyMode = 'paginated';
  const entries = [...all].reverse(), originalRpc = r.rpc.bind(r); let pauseNext = false, paused = false, failRead = false;
  r.rpc = async (method, params) => {
    if (method !== 'thread/items/list') return originalRpc(method, params);
    if (pauseNext) { pauseNext = false; paused = true; await new Promise(resolve => { releasePaused = resolve; }); }
    if (failRead) throw new Error('Synthetic saved history unavailable');
    const start = Number(params.cursor || 0); return { data: entries.slice(start, start + 100), nextCursor: start + 100 < entries.length ? String(start + 100) : null };
  };
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' }); const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true }), composer = chat.getByRole('textbox', { name: 'Message Codex', exact: true });
  await composer.fill('Keep this unsent draft');
  // Establish the retained native draft before arming the independent held
  // history response; its debounce/refresh must not race the initial click.
  await expect.poll(() => r.draft).toBe('Keep this unsent draft');
  pauseNext = true; await chat.getByRole('button', { name: 'Load older messages', exact: true }).click(); await expect.poll(() => paused).toBe(true);
  await composer.focus();await page.keyboard.press('Control+f');
  const search = chat.getByRole('search'), input = search.getByRole('textbox', { name: 'Search conversation', exact: true }); await expect(input).toBeFocused();
  assert.equal(await input.evaluate(element => getComputedStyle(element).boxShadow), 'none');
  assert.equal(await input.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  assert.equal(await search.evaluate(element => getComputedStyle(element).boxShadow), 'none');
  assert.equal(await chat.locator('[data-chat-item="item-20"]').count(), 0);
  await input.fill('Ancient unique'); await expect(search.getByRole('status')).toContainText('Search complete');
  await search.getByRole('list', { name: 'History search results', exact: true }).getByRole('button').click();
  const target = chat.locator('[data-chat-item="item-20"]'); await expect(target).toBeVisible(); await expect(target).toBeFocused();await expect(target.locator('.chat-prose')).toContainText('Ancient unique target'); await expect(target).toHaveAttribute('data-search-target', 'true');
  const oldPageFinished = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/chat') && response.request().postDataJSON()?.action === 'history');
  releasePaused(); await oldPageFinished; await expect(chat.getByRole('button', { name: 'Loading history…', exact: true })).toHaveCount(0); await expect(target).toBeVisible();
  await expect(target.locator('mark').first()).toBeVisible(); await expect(composer).toHaveValue('Keep this unsent draft');
  await expect(chat.getByLabel('Prompt context')).toContainText('Saved message 580'); assert.deepEqual(r.attachments, [reference]);
  r.upsert({ id: 'incoming', type: 'agentMessage', text: 'Newest incoming message', status: 'completed' }); r.changed();
  await expect(chat.getByRole('button', { name: /^Back to latest/ })).toBeVisible(); await expect(target).toBeVisible();
  await search.getByRole('button', { name: 'Close conversation search', exact: true }).click(); await expect(composer).toBeFocused();
  await chat.getByRole('button', { name: /^Back to latest/ }).click(); await expect(target).toHaveCount(0); await expect(chat.getByText('Newest incoming message', { exact: true })).toBeVisible();
  await composer.focus();await page.keyboard.press('Control+f'); await input.fill('Saved message');
  await expect(search.getByRole('listitem')).toHaveCount(50); await search.getByRole('button', { name: 'Search older history', exact: true }).click();
  await expect(search.getByRole('status')).toContainText('results page 2'); await search.getByRole('button', { name: 'Previous', exact: true }).click(); await expect(search.getByRole('status')).toContainText('results page 1');
  pauseNext = true; paused = false; await input.fill('delayed search'); await expect.poll(() => paused).toBe(true);
  await input.fill('Ancient unique'); await expect(search.getByRole('status')).toContainText('Search complete'); releasePaused();
  await expect(search.getByRole('list', { name: 'History search results', exact: true }).getByRole('button')).toContainText('Ancient unique target');
  failRead = true; await input.fill('unavailable marker'); await expect(search.getByRole('alert')).toContainText('unavailable'); await expect(search.getByText('No matches in saved history.', { exact: true })).toHaveCount(0);
  failRead = false; await search.getByRole('button', { name: 'Retry search', exact: true }).click(); await expect(search.getByText('No matches in saved history.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 430, height: 850 }); await input.fill('Ancient unique'); await expect(search.getByRole('status')).toContainText('Search complete');
  assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth)); await input.press('Escape'); await expect(search).toHaveCount(0); await expect(composer).toHaveValue('Keep this unsent draft');
  assert.equal(transport.calls.filter(call => call.method === 'turn/start' || call.method === 'turn/steer').length, 0); assert.deepEqual(errors, []);
  console.log('PASS: unloaded saved result, bounded source opening, retained draft/context/file, live arrivals/Latest, result pages, stale-query discard, read-error distinction and narrow layout. No model/login/user Hub.');
} finally { releasePaused?.(); await browser?.close(); await service?.close(); await cleanupFixtures(); }
