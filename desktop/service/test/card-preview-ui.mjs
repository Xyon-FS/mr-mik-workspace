import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-preview-ui-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await writeFile(path.join(repo, 'ui/index.html'), '<html>Fixture</html>');
const service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: path.join(repo, 'native-home'), env: {} } });
let browser;
try {
  const card = await service.projects.createCard({ title: 'HTTP preview' });
  const token = service.bridge.issue('preview-test', null, card.id);
  const destination = await service.bridge.call(token, 'mrmak_hub_destination', { kind: 'card', title: 'Interactive page' });
  await writeFile(destination.path, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px}button{padding:12px}</style></head><body><h1>HTTP card preview</h1><button onclick="this.textContent=\'Verified\'">Test interaction</button></body></html>');
  const { previewUrl } = await service.bridge.call(token, 'mrmak_register_hub_file', { destinationId: destination.destinationId });
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage();
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 750 });
    await page.goto(previewUrl);
    await page.getByRole('heading', { name: 'HTTP card preview' }).waitFor();
    await page.getByRole('button', { name: 'Test interaction' }).click();
    await page.getByRole('button', { name: 'Verified' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  console.log('PASS: Bridge-issued HTTP preview renders and interacts at wide and narrow widths. This does not override native browser authorization.');
} finally { await browser?.close(); await service.close(); await cleanupFixtures(); }
