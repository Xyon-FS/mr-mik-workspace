import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-theme-ui-'));
const repo = path.join(base, 'hub'), home = path.join(base, 'home');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await mkdir(path.join(repo, 'context'), { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
await writeFile(path.join(repo, 'context', 'goals.md'), '# Goals\n');
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home, env: {} } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  for (const name of ['New Codex chat', 'New Claude chat']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.waitFor();
    assert.equal(await button.textContent(), '');
    assert.equal(await button.locator('svg').count(), 2);
    assert.equal(await button.getAttribute('title'), name);
  }
  const samples = [];
  for (const theme of ['rose', 'violet', 'blue', 'teal']) {
    await page.getByRole('button', { name: 'Toggle settings' }).click();
    await page.getByRole('button', { name: `${theme[0].toUpperCase()}${theme.slice(1)} accent`, exact: true }).click();
    await page.waitForFunction(theme => document.documentElement.dataset.accentTheme === theme, theme);
    await page.getByRole('button', { name: 'Toggle projects' }).click();
    const description = await page.locator('.hub-help').first().evaluate(el => getComputedStyle(el).color);
    const label = await page.locator('.hub-form label').first().evaluate(el => getComputedStyle(el).color);
    const placeholder = await page.locator('.hub-picker input').first().evaluate(el => getComputedStyle(el, '::placeholder').color);
    const browse = await page.locator('.hub-picker button').first().evaluate(el => getComputedStyle(el).color);
    const status = await page.evaluate(() => {
      const el = document.createElement('p'); el.className = 'desk-error-inline';
      document.querySelector('.hub-panel-scroll').appendChild(el);
      const color = getComputedStyle(el).color; el.remove(); return color;
    });
    await page.screenshot({ path: path.join(base, `${theme}-workspaces.png`) });
    await page.getByRole('button', { name: 'Toggle files' }).click();
    await page.getByRole('button', { name: 'Main folders', exact: true }).click();
    await page.locator('.file-row.directory').first().waitFor();
    const folder = await page.locator('.file-row.directory>svg:nth-child(2)').first().evaluate(el => getComputedStyle(el).color);
    const panel = await page.locator('.hub-rail-content').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.screenshot({ path: path.join(base, `${theme}-folders.png`) });
    await page.getByRole('button', { name: 'Browse files', exact: true }).click();
    await page.getByRole('combobox', { name: 'File browser root' }).click();
    const overlay = await page.locator('.desk-dark-options').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.screenshot({ path: path.join(base, `${theme}-menu.png`) });
    samples.push({ theme, folder, panel, overlay, description, label, placeholder, browse, status });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle files' }).click();
  }
  for (const property of ['folder', 'panel', 'overlay', 'description', 'label', 'placeholder', 'browse']) assert.equal(new Set(samples.map(item => item[property])).size, 4, `${property} should follow each accent`);
  assert.equal(new Set(samples.map(item => item.status)).size, 1, 'Error colours must not follow the accent');
  assert.equal(samples[0].label, 'rgb(156, 149, 164)', 'Rose must retain its original label ink');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'Icon shortcuts and all four folder/panel/menu themes passed in an isolated Hub.', screenshots: base, samples }));
} finally { await browser?.close(); service.sessions.items.clear(); await service.close(); }
