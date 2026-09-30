// Isolated production UI: no real agent, account, Hub, or native picker.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await cp(path.join(root, 'public/assets'), path.join(root, 'dist/assets'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache/snapshot-ui-'));
await mkdir(path.join(repo, 'workspace')); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(repo, 'fake-home'), env: {} } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/files/pick', async route => {
    const { requestId } = route.request().postDataJSON(); await route.fulfill({ json: { requested: true } });
    await page.evaluate(requestId => window.dispatchEvent(new CustomEvent('mrmak-picked-files', { detail: { requestId, paths: ['C:\\FixtureSnapshot'] } })), requestId);
  });
  await page.route('**/api/workspace/snapshot/preview', route => route.fulfill({ json: { path: 'C:\\FixtureSnapshot', metadataConflict: true, manifest: { project: { id: 'fixture', name: 'Fixture workspace', repositories: [{ id: 'primary', name: 'Unity' }] }, cards: [{}], resources: [{}] }, files: [{ name: 'workspace/card/index.html', status: 'conflict' }] } }));
  let submitted;
  await page.route('**/api/workspace/snapshot/import', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { backup: 'Fixture backup' } }); });
  await page.goto(service.urls.workspace, { waitUntil: 'domcontentloaded' });
  await page.locator('.mak-logo').first().waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('img.mak-logo')).every(image => image.complete && image.naturalWidth > 0));
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  assert.equal(await page.getByRole('button', { name: 'Export workspace…', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Import snapshot…', exact: true }).click();
  const importButton = page.getByRole('button', { name: 'Import with backup', exact: true }); await importButton.waitFor();
  assert.equal(await importButton.isDisabled(), true);
  await page.locator('label.setting-toggle').filter({ hasText: 'Replace workspace metadata' }).getByRole('checkbox').check();
  assert.equal(await importButton.isDisabled(), true);
  await page.locator('label.setting-toggle').filter({ hasText: 'Replace workspace/card/index.html' }).getByRole('checkbox').check();
  assert.equal(await importButton.isDisabled(), false);
  await page.screenshot({ path: path.join(repo, 'snapshot-preview.png') });
  await importButton.click();
  await page.getByRole('status').filter({ hasText: 'Workspace imported' }).waitFor();
  assert.deepEqual(submitted.replaceFiles, ['workspace/card/index.html']); assert.equal(submitted.replaceMetadata, true);
  assert.deepEqual(errors, []);
  console.log(`Snapshot UI passed: safe default, explicit metadata/file replacement, results. Screenshot: ${path.join(repo, 'snapshot-preview.png')}`);
} finally { await browser?.close(); await service.close(); }
