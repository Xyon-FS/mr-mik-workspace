import { testBrowserEnvironment } from './fixtures.mjs';
// Production service/UI, disposable Hub and browser, no native agent/model calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-card-sync-ui-'));
let service, browser;
try {
  const repo = path.join(root, 'hub'), home = path.join(root, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(home, '.codex/config.toml'), '# Isolated fixture');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(root, 'accounts') } });
  const card = await service.projects.createCard({ title: 'Sync acceptance' });
  const token = service.bridge.issue('fixture', null, card.id);
  const target = await service.bridge.call(token, 'mrmak_hub_destination', { kind: 'card', title: 'Live page' });
  await writeFile(target.path, '<html><body><h1>Before sync</h1></body></html>');
  await service.bridge.call(token, 'mrmak_register_hub_file', { destinationId: target.destinationId });
  const note = await service.bridge.call(token, 'mrmak_hub_destination', { kind: 'card', title: 'Live note', format: 'markdown' });
  await writeFile(note.path, '# Original note'); await service.bridge.call(token, 'mrmak_register_hub_file', { destinationId: note.destinationId });
  browser = await chromium.launch({ env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto(service.urls.workspace + `#/${card.id}/0`);
  // Use the actual registry route syntax used by the sidebar.
  const link = page.getByRole('link', { name: /Sync acceptance/ }).first();
  if (await link.count()) await link.click();
  const frame = page.frameLocator('iframe.report-frame');
  await expect(frame.getByRole('heading', { name: 'Before sync' })).toBeVisible({ timeout: 15000 });
  await writeFile(target.path, '<html><body><h1>After sync</h1></body></html>');
  await expect(frame.getByRole('heading', { name: 'After sync' })).toBeVisible({ timeout: 15000 });
  await writeFile(target.path, 'Partial document');
  await expect(page.getByRole('status').filter({ hasText: 'last preview' })).toBeVisible({ timeout: 15000 });
  await expect(frame.getByRole('heading', { name: 'After sync' })).toBeVisible();
  await page.evaluate(hash => { window.location.hash = hash; }, `#/${card.id}/1`);
  await expect(page.getByRole('heading', { name: 'Original note' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('textarea.markdown-editor');
  await editor.fill('# Unsaved local draft');
  await writeFile(note.path, '# External update');
  await expect(page.getByRole('status').filter({ hasText: 'File changed externally' })).toBeVisible({ timeout: 15000 });
  await expect(editor).toHaveValue('# Unsaved local draft');
  assert.equal((await service.sessions.list()).length, 0);
  assert.equal(await readFile(note.path, 'utf8'), '# External update');
  console.log('Card sync UI passed: native edits refresh production iframe; incomplete saves retain preview; Markdown drafts survive external changes; no agent session started.');
} finally {
  await browser?.close(); await service?.close(); await cleanupFixtures();
}
