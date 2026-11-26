// Actual new-chat dialog with synthetic native protocol; no real accounts/prompts.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { CodexChat } from '../codex-chat.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-preparation-handoff-ui-'));
let service, browser, releaseStartup;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await writeFile(path.join(native, 'config.toml'), 'model="fixture-model"\n');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: native, CODEX_SQLITE_HOME: native } } });
  const profile = await service.profiles.create('Synthetic handoff'), wire = pooledCodexFixture();
  service.profiles.assertIdentity = async () => ({ identityState: 'verified' });
  service.sessions.verifyAccount = async session => { session.verifyStartupAccount = async () => {}; };
  service.sessions.verifyIdentity = async () => {};
  const launch = service.codexPreparation.launch;
  service.codexPreparation.launch = async context => ({ ...await launch(context), spawnChild: wire.spawnChild });
  const startupGate = new Promise(resolve => { releaseStartup = resolve; });
  service.sessions.createGraphicalRuntime = options => {
    const runtime = new CodexChat({ ...options, workerPool: service.sessions.codexWorkers, spawnChild: wire.spawnChild }), start = runtime.start.bind(runtime);
    runtime.start = async () => { await startupGate; return start(); }; return runtime;
  };
  browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } }), cancellations = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/codexpreparation') && request.method() === 'POST' && request.postDataJSON()?.cancel) cancellations.push(request); });
  await page.goto(service.urls.chats);
  const openDialog = async () => {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
    const dialog = page.locator('form.desk-dialog'); await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Codex account', exact: true }).click();
    await page.getByRole('option', { name: 'Synthetic handoff', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Chat interface', exact: true }).click();
    await page.getByRole('option', { name: 'Chat', exact: true }).click();
    await expect.poll(() => service.codexPreparation.status, { timeout: 15000 }).toBe('ready');
    return dialog;
  };
  let dialog = await openDialog();
  const prepared = service.sessions.codexWorkers.workers.get(service.codexPreparation.readyKey).transport;
  const before = cancellations.length;
  const response = page.waitForResponse(r => r.url() === service.origin + '/api/sessions' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Open chat', exact: true }).click();
  const created = await (await response).json(); await expect(dialog).toBeHidden();
  // A round trip after React cleanup ensures cancellation requests are observed.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(cancellations.length, before); assert.equal(prepared.closed, false);
  releaseStartup(); await service.sessions.get(created.id).startupPromise;
  assert.equal(service.sessions.get(created.id).graphical.transport, prepared);
  await service.sessions.remove(created.id);
  dialog = await openDialog(); const dismissed = cancellations.length;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => cancellations.length).toBeGreaterThan(dismissed);
  assert.deepEqual(errors, []);
  console.log('PASS actual dialog: launch unmount preserves preparation until delayed adoption; explicit dismissal still cancels; no inference.');
} finally {
  releaseStartup?.(); await browser?.close(); await service?.close(); await cleanupFixtures();
}
