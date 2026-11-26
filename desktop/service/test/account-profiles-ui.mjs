import { testBrowserEnvironment } from './fixtures.mjs';
// Production UI acceptance. Native login and worker execution are replaced by
// bounded fixtures; no real account, model, Hub or installed app is used.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(root, '.cache/account-profiles-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), systemHome = path.join(home, '.codex'), uiDir = path.join(base, 'ui');
  for (const folder of [path.join(repo, 'workspace'), systemHome]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
  await writeFile(path.join(systemHome, 'config.toml'), '# fixture system\n');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: false } });
  const env = { ...process.env, CODEX_HOME: systemHome, CODEX_SQLITE_HOME: systemHome };
  service = await createService({ repo, uiDir, mcpOptions: { home, env }, profileOptions: { root: path.join(base, 'accounts') } });
  const signedIn = new Set(); service.accounts.status = async (_agent, _resolve, env) => signedIn.has(env.CODEX_HOME) ? 'logged-in' : 'logged-out';
  const logins = []; service.accounts.launch = async (command, env, options) => {
    assert.equal(options.silent, true); logins.push(command);
    assert.equal(options.privateLogin, command.args.at(-1) === 'login');
    if (command.args.at(-1) === 'login') {
      signedIn.add(env.CODEX_HOME);
      const user = path.basename(env.CODEX_HOME), claims = Buffer.from(JSON.stringify({ sub: user, email: `${user}@example.test` })).toString('base64url');
      await writeFile(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: `synthetic-${user}`, id_token: `fixture.${claims}.fixture` } }));
    } else { signedIn.delete(env.CODEX_HOME); await unlink(path.join(env.CODEX_HOME, 'auth.json')); }
    return { requested: true, completed: true };
  };
  const launches = [];
  service.sessions.verifyAccount = async () => {};
  service.sessions.permissionReady = async () => true;
  service.sessions.launch = async session => {
    const account = await service.sessions.accountContext(session);
    launches.push({ profileId: session.accountProfileId, context: account });
    const listeners = new Set();
    session.process = {
      resize() {}, write() {},
      onExit(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
      kill() { session.process = null; for (const callback of [...listeners]) callback(); },
    };
    session.accountProfileLabel = account.label; session.launchedCodexPermissions = session.codexPermissions;
    session.status = 'running'; session.hasConversation = false; service.sessions.changed(session);
  };
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Codex account profiles' });
  await expect(settings.getByText('System / current Codex', { exact: true })).toHaveCount(0);
  const chats = await context.newPage(); chats.on('pageerror', error => errors.push(error.message));
  await chats.goto(service.urls.chats);
  await chats.getByRole('button', { name: 'Open your first chat', exact: true }).click();
  await expect(chats.getByRole('combobox', { name: 'Codex account', exact: true })).toContainText('Connect an account first');
  await expect(chats.getByRole('button', { name: 'Open chat', exact: true })).toBeDisabled();
  await chats.getByRole('button', { name: 'Close', exact: true }).click();
  await settings.getByRole('button', { name: 'Connect Codex account', exact: true }).click();
  const row = settings.locator('.account-row').filter({ has: page.getByText('Account 1', { exact: true }) });
  await expect(row).toBeVisible(); await expect.poll(() => logins.length).toBe(1);
  await expect(row.locator('.account-status.logged-in')).toContainText('Logged in');
  await expect(row.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Codex profile account action' })).toHaveCount(0);
  await page.screenshot({ path: path.join(root, '.cache/codex-account-settings-ui.png') });
  const profile = (await service.profiles.list()).find(item => item.label === 'Account 1'); assert.ok(profile);
  await settings.getByRole('button', { name: 'Connect Codex account', exact: true }).click();
  await expect(settings.getByText('Account 2', { exact: true })).toBeVisible();
  await expect.poll(() => logins.length).toBe(2);
  const second = (await service.profiles.list()).find(item => item.label === 'Account 2'); assert.ok(second);
  const secondRow = settings.locator('.account-row').filter({ has: page.getByText('Account 2', { exact: true }) });
  await expect(secondRow.getByText('Logged in', { exact: false })).toBeVisible();
  const firstAuth = path.join(base, 'accounts/profiles', profile.id, 'auth.json'), secondAuth = path.join(base, 'accounts/profiles', second.id, 'auth.json');
  const originalSecond = await readFile(secondAuth, 'utf8');
  await writeFile(secondAuth, await readFile(firstAuth));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row.getByText('Same account as Account 2. Sign out the duplicate.', { exact: true })).toBeVisible();
  await expect(secondRow.getByText('Account identity changed. Sign out and reconnect.', { exact: true })).toBeVisible();
  await writeFile(secondAuth, originalSecond);
  await service.profiles.mutate(registry => { delete registry.profiles.find(item => item.id === second.id).identity; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(secondRow.getByRole('button', { name: 'Verify account', exact: true })).toBeVisible();
  await secondRow.getByRole('button', { name: 'Verify account', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm account action', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(secondRow.getByRole('button', { name: 'Verify account', exact: true })).toHaveCount(0);
  assert.equal((await service.profiles.assertIdentity(second.id)).identityState, 'verified');
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  await page.getByRole('button', { name: 'Diagnostics', exact: false }).click();
  await expect(page.getByText('Settings are shared across accounts.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close diagnostics', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Codex account', exact: true })).toHaveCount(0);
  // Open the existing Chats surface after checking common Tools.
  await chats.getByRole('button', { name: 'Open your first chat', exact: true }).click();
  await chats.getByRole('combobox', { name: 'Codex account', exact: true }).click();
  await chats.getByRole('option', { name: 'Account 1', exact: true }).click();
  await chats.getByPlaceholder('e.g. Dream Game · animations').fill('Profile fixture chat');
  await chats.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect.poll(() => launches.length).toBe(1);
  assert.equal(launches[0].profileId, profile.id);
  assert.equal(launches[0].context.profileId, profile.id);
  assert.equal(launches[0].context.env.OPENAI_API_KEY, undefined);
  const session = service.sessions.list()[0]; assert.equal(session.accountProfileId, profile.id);
  await expect(chats.locator('.chat-context').getByRole('combobox', { name: 'Codex account', exact: true })).toHaveCount(0);
  await chats.locator('.cli-session-settings > summary').click();
  const activeAccount = chats.locator('.cli-session-settings-panel').getByRole('combobox', { name: 'Codex account', exact: true });
  await expect(activeAccount).toContainText('Account 1');
  await activeAccount.click();
  await expect(chats.getByRole('option', { name: 'System / current Codex', exact: true })).toHaveCount(0);
  await chats.getByRole('option', { name: 'Account 2', exact: true }).click();
  await expect.poll(() => launches.length).toBe(2);
  await expect(activeAccount).toContainText('Account 2');
  assert.equal(service.sessions.list()[0].id, session.id);
  assert.equal(service.sessions.list()[0].accountProfileId, second.id);
  // A restored System chat is stopped and can be explicitly mapped from this menu.
  const legacy = service.sessions.get(session.id);
  legacy.accountProfileId = 'system'; legacy.process = null; legacy.status = 'stopped'; service.sessions.changed(legacy);
  await expect(activeAccount).toContainText('Choose account');
  await activeAccount.click(); await chats.getByRole('option', { name: 'Account 1', exact: true }).click();
  await expect.poll(() => launches.length).toBe(3);
  await expect(activeAccount).toContainText('Account 1');
  await activeAccount.click(); await chats.getByRole('option', { name: 'Account 2', exact: true }).click();
  await expect.poll(() => launches.length).toBe(4);
  await expect(chats.locator('.desktop-error')).toHaveCount(0);
  // Deliberately retained visual evidence, outside the tracked temporary fixture.
  await chats.screenshot({ path: path.join(root, '.cache/codex-account-revision-ui.png') });
  assert.equal(await readFile(path.join(systemHome, 'config.toml'), 'utf8'), '# fixture system\n');
  await page.getByRole('button', { name: 'Toggle mcp' }).click();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  await settings.locator('.account-row').filter({ has: page.getByText('Account 1', { exact: true }) }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(row).toHaveCount(0);
  await activeAccount.click();
  await expect(chats.getByRole('option', { name: 'Account 1', exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('Production account menu placement, added-only selection, no-account state and legacy System mapping passed. No native login or model request.');
} finally {
  await browser?.close(); await service?.close(); await cleanupFixtures();
}
