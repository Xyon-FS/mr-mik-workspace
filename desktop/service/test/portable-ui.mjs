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
  let accountConfirmed = 0;
  await page.route('**/api/accounts', route => route.fulfill({ json: ['codex', 'claude', 'opencode'].map(agent => ({ agent, label: agent === 'opencode' ? 'OpenCode' : agent === 'codex' ? 'Codex' : 'Claude', available: true, status: agent === 'claude' ? 'logged-out' : 'logged-in', ...(agent === 'opencode' ? { providers: [{ provider: 'openai', label: 'OpenAI', status: 'logged-in', canLogout: true }] } : {}) })) }));
  await page.route('**/api/accounts/plan', route => { const { agent, action } = route.request().postDataJSON(); return route.fulfill({ json: { token: 'account-fixture', agent, action, label: agent } }); });
  await page.route('**/api/accounts/confirm', route => { assert.deepEqual(route.request().postDataJSON(), { token: 'account-fixture' }); accountConfirmed++; return route.fulfill({ json: { requested: true } }); });
  const native = ['new', 'update', 'identical', 'local-newer', 'conflict'].map((status, index) => ({ agent: index === 4 ? 'opencode' : index % 2 ? 'claude' : 'codex', id: `chat-${index}`, name: `Fixture ${status}`, status }));
  native.push({ agent: 'codex', id: 'codex-conflict', name: 'Codex conflict', status: 'conflict' });
  native.push({ agent: 'claude', id: 'missing-fixture', key: 'claude:missing-fixture', name: 'Missing fixture', status: 'unavailable', reason: 'Native transcript missing' });
  native[4].familySize = 3;
  await page.route('**/api/files/pick', async route => {
    const { requestId } = route.request().postDataJSON();
    await route.fulfill({ json: { requested: true } });
    await page.evaluate(requestId => window.dispatchEvent(new CustomEvent('mrmak-picked-files', { detail: { requestId, paths: ['C:\\Fixture.mrmak.zip'] } })), requestId);
  });
  await page.route('**/api/workspace/import/preview', route => route.fulfill({ json: { manifest: { chats: 'full', files: [], projectPaths: {}, native }, native, hubConflicts: [], reviewHash: 'fixture-hash' } }));
  let submitted;
  await page.route('**/api/workspace/import', route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { imported: 2, skipped: 2, nativeImported: 1, nativeUpdated: 1, sessionsUpdated: 1, nativeSkipped: 2, backup: 'Fixture backup' } });
  });
  await page.goto(service.urls.workspace, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Choose archive to import…' }).click();
  assert.equal(await page.getByRole('button', { name: 'Import into this Hub', exact: true }).isDisabled(), true);
  await page.locator('label.setting-toggle').filter({ hasText: 'Continue without these native conversations' }).getByRole('checkbox').check();
  await page.getByText('Continuation · updates automatically', { exact: false }).waitFor();
  await page.getByText('Local continuation · kept', { exact: false }).waitFor();
  await page.getByText('Identical · no transcript copy', { exact: false }).waitFor();
  const replace = page.getByRole('checkbox').filter({ visible: true });
  assert.equal(await page.locator('label.setting-toggle').filter({ hasText: 'Replace Fixture conflict' }).count(), 0);
  await page.getByText('Keep Fixture conflict', { exact: true }).waitFor();
  await page.getByText('3 sessions including subagents', { exact: false }).waitFor();
  await page.getByText('Task lists are archived as reference only', { exact: false }).waitFor();
  const conflict = page.locator('label.setting-toggle').filter({ hasText: 'Replace Codex conflict' }).getByRole('checkbox');
  assert.equal(await conflict.isChecked(), false);
  await conflict.check();
  assert.ok(await replace.count() > 0);
  await page.screenshot({ path: path.join(repo, 'transfer-preview.png') });
  await page.getByRole('button', { name: 'Import into this Hub' }).click();
  await page.getByRole('status').filter({ hasText: 'updated 1 native chats and 1 History entries' }).waitFor();
  assert.deepEqual(submitted.skipNative, ['claude:missing-fixture']); assert.equal(submitted.reviewHash, 'fixture-hash');
  let exportRequest = null;
  await page.route('**/api/workspace/export/preview', route => route.fulfill({ json: { token: 'fixture-review', files: [{ path: 'C:\\Linked project\\sample.png', bytes: 2048 }], issues: [{ key: 'opencode:ses_missing', agent: 'opencode', name: 'Missing family', reason: 'Native family missing' }] } }));
  await page.route('**/api/workspace/export', async route => { exportRequest = route.request().postDataJSON(); await route.fulfill({ json: { path: 'Fixture archive', files: 5, chats: 1 } }); });
  await page.getByRole('button', { name: 'Export · full', exact: true }).click();
  await page.getByText('Review OpenCode attachments', { exact: true }).waitFor();
  const confirm = page.getByRole('button', { name: 'Confirm full export', exact: true });
  assert.equal(await confirm.isDisabled(), true); assert.equal(exportRequest, null);
  await page.locator('label.setting-toggle').filter({ hasText: 'Include all listed files' }).getByRole('checkbox').check();
  assert.equal(await confirm.isDisabled(), true);
  await page.locator('label.setting-toggle').filter({ hasText: 'Continue without these native conversations' }).getByRole('checkbox').check();
  await page.screenshot({ path: path.join(repo, 'attachment-review.png') });
  await confirm.click();
  await page.getByRole('status').filter({ hasText: 'Export saved: Fixture archive' }).waitFor();
  assert.equal(exportRequest.attachmentToken, 'fixture-review'); assert.equal(exportRequest.approveAttachments, true);
  assert.deepEqual(exportRequest.skipNative, ['opencode:ses_missing']);
  assert.equal(await page.getByRole('button', { name: 'Sign in Codex', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Sign out Claude', exact: true }).count(), 0);
  await page.locator('.account-list').evaluate(element => { element.style.width = '320px' });
  const wide = await page.locator('.account-row').first().evaluate(row => {
    const name = row.querySelector('strong').getBoundingClientRect(), status = row.querySelector('small').getBoundingClientRect(), actions = row.querySelector('.account-actions').getBoundingClientRect();
    return [name.y + name.height / 2, status.y + status.height / 2, actions.y + actions.height / 2];
  });
  assert.ok(Math.max(...wide) - Math.min(...wide) < 2, 'Account name, status and action align on one row');
  await page.locator('.account-list').evaluate(element => { element.style.width = '240px' });
  assert.equal(await page.locator('.account-row').first().evaluate(row => row.querySelector('small').getBoundingClientRect().top > row.querySelector('strong').getBoundingClientRect().bottom), true);
  await page.locator('.account-list').evaluate(element => { element.style.width = '' });
  await page.locator('.accounts-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(repo, 'account-rows.png') });
  for (const [label, action] of [['Codex', 'out'], ['Claude', 'in'], ['OpenCode · OpenAI', 'out']]) {
    await page.getByRole('button', { name: `Sign ${action} ${label}`, exact: true }).click();
    await page.getByRole('dialog', { name: 'Native account confirmation' }).waitFor();
    assert.equal(accountConfirmed, 0);
    await page.getByRole('button', { name: 'Cancel account action', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Sign in Claude', exact: true }).click();
  await page.getByRole('dialog', { name: 'Native account confirmation' }).waitFor();
  await page.screenshot({ path: path.join(repo, 'account-confirmation.png') });
  await page.getByRole('button', { name: 'Open native sign-in', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Native account terminal opened' }).waitFor();
  assert.equal(accountConfirmed, 1);
  assert.deepEqual(submitted.replaceNative, ['codex:codex-conflict']);
  assert.equal(submitted.restoreSettings, false);
  assert.deepEqual(errors, []);
  console.log(`Transfer UI passed: all five statuses, OpenCode conflict refusal, Codex replacement choice, results and no JS errors. Screenshot: ${path.join(repo, 'transfer-preview.png')}`);
} finally { await browser?.close(); await service.close(); }
