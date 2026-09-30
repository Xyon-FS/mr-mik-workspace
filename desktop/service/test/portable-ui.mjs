// Production UI against an isolated Hub and mocked transfer responses.
// No real CLI, account, user conversation or native file picker is used.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repo = await mkdtemp(path.join(root, '.cache/transfer-ui-'));
for (const folder of ['workspace', 'projects', 'knowledge', 'processes', 'inbox', 'context']) await mkdir(path.join(repo, folder));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
await writeFile(path.join(repo, 'projects/registry.json'), JSON.stringify({ projects: [] }));
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(repo, 'fake-home'), env: {} } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const native = ['new', 'update', 'identical', 'local-newer', 'conflict'].map((status, index) => ({ agent: index % 2 ? 'claude' : 'codex', id: `chat-${index}`, name: `Fixture ${status}`, status }));
  await page.route('**/api/files/pick', async route => {
    const { requestId } = route.request().postDataJSON();
    await route.fulfill({ json: { requested: true } });
    await page.evaluate(requestId => window.dispatchEvent(new CustomEvent('mrmak-picked-files', { detail: { requestId, paths: ['C:\\Fixture.mrmak.zip'] } })), requestId);
  });
  await page.route('**/api/workspace/import/preview', route => route.fulfill({ json: { manifest: { chats: 'full', files: [], projectPaths: {}, native }, native, hubConflicts: [] } }));
  let submitted;
  await page.route('**/api/workspace/import', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { imported: 2, skipped: 2, nativeImported: 1, nativeUpdated: 1, sessionsUpdated: 1, nativeSkipped: 2, backup: 'Fixture backup' } });
  });
  await page.goto(service.urls.workspace, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Choose archive to import…' }).click();
  await page.getByText('Continuation · updates automatically', { exact: false }).waitFor();
  await page.getByText('Local continuation · kept', { exact: false }).waitFor();
  await page.getByText('Identical · no transcript copy', { exact: false }).waitFor();
  const replace = page.getByRole('checkbox').filter({ visible: true });
  const conflict = page.locator('label.setting-toggle').filter({ hasText: 'Replace Fixture conflict' }).getByRole('checkbox');
  assert.equal(await conflict.isChecked(), false);
  await conflict.check();
  assert.ok(await replace.count() > 0);
  await page.screenshot({ path: path.join(repo, 'transfer-preview.png') });
  await page.getByRole('button', { name: 'Import into this Hub' }).click();
  await page.getByRole('status').filter({ hasText: 'updated 1 native chats and 1 History entries' }).waitFor();
  assert.deepEqual(submitted.replaceNative, ['codex:chat-4']);
  assert.equal(submitted.restoreSettings, false);
  assert.deepEqual(errors, []);
  console.log(`Transfer UI passed: all five statuses, explicit conflict choice, results and no JS errors. Screenshot: ${path.join(repo, 'transfer-preview.png')}`);
} finally { await browser?.close(); await service.close(); }
