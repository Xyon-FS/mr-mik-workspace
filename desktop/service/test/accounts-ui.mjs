import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { mkdtemp, createService, testBrowserEnvironment } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-accounts-ui-')));
const repo = path.join(base, 'hub');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(base, 'home'), env: {} } });
let browser;
try {
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], plans = []; page.on('pageerror', error => errors.push(error.message));
  let accountRows = [
    { agent: 'codex', label: 'Codex', available: true, status: 'logged-in' },
    { agent: 'claude', label: 'Claude', available: true, status: 'logged-out' },
    { agent: 'opencode', label: 'OpenCode', available: true, status: 'logged-in', providers: [
      { provider: 'anthropic', label: 'anthropic', status: 'logged-in', canLogout: true },
      { provider: 'google', label: 'google', status: 'logged-in', canLogout: false },
    ] },
  ];
  await page.route('**/api/accounts/profiles*', route => route.fulfill({ json: [{ id: 'fixture-account', label: 'Test account', available: true, status: 'logged-in', identityState: 'verified' }] }));
  const limitQueries = [];
  await page.route('**/api/accounts/limits?*', route => { limitQueries.push(new URL(route.request().url()).searchParams); return route.fulfill({ json: { windows: [{ label: '5h window', percent: 0, resetsAt: '2030-01-01T00:00:00Z' }], note: 'Native fixture usage' } }); });
  await page.route('**/api/accounts', route => route.fulfill({ json: accountRows }));
  await page.route('**/api/accounts/plan', route => {
    const request = route.request().postDataJSON(); plans.push(request);
    return route.fulfill({ json: { token: 'fixture', agent: request.agent, action: request.action, label: `OpenCode · ${request.provider || 'provider picker'}` } });
  });
  await page.route('**/api/accounts/confirm', () => { throw new Error('UI fixture must not execute auth.'); });
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'OpenCode', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out OpenCode · anthropic', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign out OpenCode · google', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Sign out OpenCode · anthropic', exact: true }).click();
  assert.deepEqual(plans[0], { agent: 'opencode', action: 'logout', provider: 'anthropic' });
  await page.getByRole('button', { name: 'Cancel account action' }).click();
  assert.equal(await page.locator('.account-provider-heading strong').textContent(), 'OpenCode');
  assert.equal(await page.locator('.account-provider-heading .account-status').count(), 0);
  const connect = page.getByRole('button', { name: 'Connect OpenCode provider', exact: true });
  assert.equal(await connect.textContent(), '');
  assert.equal(await connect.getAttribute('title'), 'Connect provider');
  assert.ok((await connect.boundingBox()).width <= 28, 'Provider connection is a compact icon');
  await connect.focus();
  assert.equal(await connect.evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: 'Connect OpenCode provider', exact: true }).click();
  assert.deepEqual(plans[1], { agent: 'opencode', action: 'login', provider: '' });
  await page.getByRole('button', { name: 'Cancel account action' }).click();
  await page.locator('.account-list').evaluate(element => { element.style.width = '220px'; });
  for (const button of await page.locator('.account-list button').all()) {
    const bounds = await button.boundingBox(), list = await page.locator('.account-list').boundingBox();
    assert.ok(bounds && list && bounds.x >= list.x && bounds.x + bounds.width <= list.x + list.width + 1, 'Account action must fit a narrow rail');
    assert.equal(await button.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Account action text must not be clipped');
  }
  await page.screenshot({ path: path.join(base, 'accounts.png'), fullPage: true });
  console.log(`Account UI screenshot: ${path.join(base, 'accounts.png')}`);
  accountRows = [{ agent: 'opencode', label: 'OpenCode', available: true, status: 'logged-out', providers: [] }];
  await page.reload();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'OpenCode', exact: true }).click();
  await page.getByText('No connected providers', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign out OpenCode', exact: true }).count(), 0);
  accountRows = [{ agent: 'opencode', label: 'OpenCode', available: true, status: 'unknown', providers: [] }];
  await page.reload();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'OpenCode', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out OpenCode', exact: true }).waitFor();
  accountRows = [{ agent: 'opencode', label: 'OpenCode', available: false, status: 'unknown', providers: [] }];
  await page.reload();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'OpenCode', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Connect OpenCode provider', exact: true }).isDisabled(), true);
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Codex account limits', exact: true }).focus();
  await page.getByRole('tooltip').getByText('5h window: 0% used', { exact: false }).waitFor();
  assert.equal(limitQueries.at(-1).get('profileId'), 'fixture-account');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(), 0);
  accountRows = [{ agent: 'claude', label: 'Claude', available: true, status: 'logged-in' }];
  await page.reload(); await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'OpenCode', exact: true }).click();
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Claude account limits', exact: true }).focus();
  await page.getByRole('tooltip').getByText('5h window: 0% used', { exact: false }).waitFor();
  assert.equal(limitQueries.at(-1).get('agent'), 'claude');
  assert.equal(limitQueries.at(-1).get('profileId'), 'system');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('Provider account rows and safe confirmation UI passed; no authentication command executed.');
} finally { await browser?.close(); await service.close(); }
