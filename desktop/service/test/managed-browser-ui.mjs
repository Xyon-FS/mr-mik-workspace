import { selectControl } from './select-control.mjs';
// Build to a tracked fixture, never the live app's dist/runtime directory.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(root, '.cache/browser-ui-'));
const repo = path.join(base, 'hub'), uiDir = path.join(base, 'ui');
let browser, service;
try {
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: false } });
  await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  service = await createService({ repo, uiDir, mcpOptions: { home: path.join(base, 'native-home'), env: {} } });
  const project = await service.projects.save({ name: 'Browser UI project' });
  await fetch(`${service.origin}/api/settings`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedProjectId: project.id }) });
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/accounts', route => route.fulfill({ json: [] }));
  await page.route('**/api/reasoning**', route => route.fulfill({ json: {
    codex: { model: 'fixture', efforts: ['medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    codexWorker: { model: 'fixture', efforts: ['medium', 'high', 'xhigh'], defaultEffort: 'xhigh' },
    claude: { efforts: ['medium', 'high', 'xhigh'], note: 'Fixture' },
  } }));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  for (const [label, value] of [['Filter MCP by agent', 'codex'], ['Filter tools by type', 'mcp'], ['Filter MCP by scope', 'global']]) {
    await selectControl(page, label, value);
    await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveAttribute('data-value', value);
  }
  await page.getByRole('combobox', { name: 'Filter tools by type', exact: true }).click();
  const typeMenu = page.getByRole('listbox', { name: 'Filter tools by type', exact: true });
  assert.notEqual(await typeMenu.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(root, '.cache/tools-dark-selectors-20261018.png') });
  await typeMenu.getByRole('option', { name: 'MCP', exact: true }).press('Escape');
  const panel = page.getByRole('region', { name: 'Mr. Mik browser tools' });
  const availability = page.getByLabel('Browser availability', { exact: true });
  await expect(availability).toHaveAttribute('data-value', 'inherit');
  await expect(panel.getByRole('combobox')).toHaveCount(2);
  await expect(page.getByRole('checkbox', { name: /Show browser window/ })).not.toBeVisible();
  await selectControl(page, 'Browser availability', 'on');
  await expect(panel.locator('.mcp-state')).toHaveText('Enabled');
  await selectControl(page, 'Browser presentation', 'external');
  await panel.getByText('Advanced', { exact: true }).click();
  await selectControl(page, 'Browser engine', 'msedge');
  const windowToggle = page.getByRole('checkbox', { name: /Show browser window/ });
  await expect(windowToggle).toBeChecked();
  await windowToggle.click();
  await expect(windowToggle).not.toBeChecked();
  await page.reload();
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  await expect(availability).toHaveAttribute('data-value', 'on');
  await expect(page.getByLabel('Browser presentation', { exact: true })).toHaveAttribute('data-value', 'external');
  await panel.getByText('Advanced', { exact: true }).click();
  await expect(page.getByLabel('Browser engine', { exact: true })).toHaveAttribute('data-value', 'msedge');
  await expect(windowToggle).not.toBeChecked();
  await selectControl(page, 'Browser availability', 'inherit');
  await expect(panel.locator('.mcp-state')).toHaveText('Off');
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  await fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ selectedProjectId: null }) });
  await page.reload();
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  await expect(availability).toHaveAttribute('data-value', 'off');
  await selectControl(page, 'Browser availability', 'on');
  await selectControl(page, 'Browser presentation', 'workspace');
  const savedSettings = await (await fetch(`${service.origin}/api/bootstrap`, { headers })).json();
  assert.equal(savedSettings.settings.managedBrowser, 'chrome');
  assert.equal(savedSettings.settings.managedBrowserProjects?.[project.id], undefined);
  assert.equal(savedSettings.settings.managedBrowserPresentationProjects[project.id], 'external');
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await expect(page.getByRole('heading', { name: 'Browser tools' })).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.equal(service.sessions.list().length, 0);
  assert.equal(service.coordinator.child, null);
  console.log('PASS: dark Tools filters, browser preferences/inheritance and persisted window choice; no CLI or coordinator started.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
