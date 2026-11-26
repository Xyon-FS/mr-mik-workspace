// Settings acceptance without any conversation. Native account probes simulated;
// actual control-only account reads are separate acceptance checks.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const root = path.resolve('.'), index = process.argv.indexOf('--portable'), portable = index < 0 ? null : path.resolve(process.argv[index + 1]);
const serviceRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service'), uiDir = portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-account-limits-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CODEX_SQLITE_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  service = await createService({ repo, uiDir, mcpOptions: { home, env }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  const codex = await service.profiles.create('Codex fixture'), first = await service.claudeProfiles.create('Claude Work'), second = await service.claudeProfiles.create('Claude Personal');
  service.accounts.status = async () => 'logged-in'; service.profiles.assertIdentity = async () => ({ identityState: 'verified' }); service.profiles.identityStates = async () => [{ id: codex.id, identityState: 'verified' }];
  service.claudeProfiles.identity = async env => ({ status: 'logged-in', identity: env.CLAUDE_CONFIG_DIR || 'current', email: null });
  const firstContext = await service.claudeProfiles.context(first.id), secondContext = await service.claudeProfiles.context(second.id), calls = [];
  service.accountLimitReader.codex = async context => { calls.push(['codex', context.profileId]); return { windows: [{ label: '5h', percent: 0, resetsAt: '2026-11-01T00:00:00Z' }] }; };
  service.accountLimitReader.claude = async context => { calls.push(['claude', context.profileId]); await new Promise(resolve => setTimeout(resolve, 100)); return { windows: [{ label: 'five hour', percent: context.directory === firstContext.directory ? 31 : context.directory === secondContext.directory ? 78 : 9, resetsAt: null }] }; };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace); await page.getByRole('button', { name: 'Toggle settings', exact: true }).click();
  await page.getByRole('button', { name: 'Accounts settings', exact: true }).click();
  const codexRegion = page.getByRole('region', { name: 'Codex account profiles', exact: true });
  await expect(codexRegion.locator('.account-status.logged-in')).toHaveCSS('color','rgb(168, 192, 172)');
  await codexRegion.getByRole('button', { name: 'Codex account limits', exact: true }).click(); await expect(codexRegion.getByRole('tooltip')).toContainText('0% used'); await expect(codexRegion.getByRole('tooltip')).toContainText('Resets'); await expect(codexRegion.getByRole('tooltip')).not.toContainText(/Account limits|Updated|Reported|Native account/i);
  const claude = page.getByRole('region', { name: 'Claude account profiles', exact: true }), work = claude.locator('.account-row').filter({ hasText: 'Claude Work' }), personal = claude.locator('.account-row').filter({ hasText: 'Claude Personal' });
  await page.getByRole('group', { name: 'Account provider', exact: true }).getByRole('button', { name: 'Claude', exact: true }).click();
  await expect(work.locator('.account-status.logged-in')).toHaveCSS('color','rgb(168, 192, 172)');
  for(const row of [codexRegion.locator('.account-row').first(),work,personal]){if(!await row.isVisible())continue;const centers=await row.locator('.account-actions button').evaluateAll(buttons=>buttons.map(button=>{const box=button.getBoundingClientRect();return box.y+box.height/2}));assert.ok(Math.max(...centers)-Math.min(...centers)<1,'Usage and account actions share one center line');}
  await work.getByRole('button', { name: 'Claude account limits', exact: true }).click(); await expect(work.getByRole('tooltip')).toContainText('31% used');
  await personal.getByRole('button', { name: 'Claude account limits', exact: true }).click(); await expect(personal.getByRole('tooltip')).toContainText('78% used'); await expect(personal.getByRole('tooltip')).not.toContainText('31%');
  assert.equal(service.sessions.items.size, 0); assert.equal(calls.filter(([agent, id]) => agent === 'claude' && id === first.id).length, 1); assert.equal(calls.filter(([agent]) => agent === 'codex').length, 1);
  await personal.getByRole('button', { name: 'Claude account limits', exact: true }).click(); await expect(personal.getByRole('tooltip')).toContainText('78% used'); assert.equal(calls.filter(([_agent, id]) => id === second.id).length, 1);
  await page.screenshot({ path: path.join(root, '.cache/account-limits-settings.png') });
  assert.doesNotMatch(await page.locator('.accounts-settings').innerText(), /Open (?:a|the).*graphical chat/i); assert.deepEqual(errors, []);
  console.log('PASS Settings account limits without any chats: Codex zero/reset, Claude per-profile percentages, deduplicated hover/focus/click and no native conversation creation.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
