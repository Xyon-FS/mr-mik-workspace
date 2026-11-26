// Production UI acceptance with a disposable Hub. No native agent or user data.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-card-archive-visibility-'));
const at = process.argv.indexOf('--portable'), portable = at < 0 ? null : path.resolve(process.argv[at + 1]);
const serviceRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
let browser, service;
try {
  const repo = path.join(base, 'hub'), external = path.join(base, 'project'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(external); await mkdir(home);
  const file = path.join(repo, 'workspace/workspace.json'); await writeFile(file, '{"entities":[]}');
  service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), mcpOptions: { home, env: {} }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  const project = await service.projects.save({ name: 'Archive fixture', repositoryPath: external });
  const card = (id, patch = {}) => ({ id, title: id, folder: id, category: 'project', type: 'group', description: '', steps: [], status: 'active', created: '2000-01-01', updated: '2000-01-02', ...patch });
  const entities = [card('old-active'), card('old-done', { status: 'done' }), card('creation-only', { updated: undefined }), card('old-pinned', { pinned: true }), card('old-project', { projectId: project.id }), card('manual-archive', { status: 'archived' }), card('pinned-archive', { status: 'archived', pinned: true }), card('recent-active', { updated: '2099-01-01' })];
  const original = JSON.stringify({ entities }); await writeFile(file, original);
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = async (route, data) => { const response = await fetch(`${service.origin}/api${route}`, { method: 'POST', headers, body: JSON.stringify(data) }); assert.ok(response.ok, await response.text()); };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  for (const id of ['old-active', 'old-done', 'creation-only', 'old-pinned', 'old-project', 'recent-active']) await expect(page.locator(`.entity-card[data-entity="${id}"]`), `${id} must remain visible regardless of age`).toBeVisible();
  for (const id of ['manual-archive', 'pinned-archive']) await expect(page.locator(`.entity-card[data-entity="${id}"]`)).toHaveCount(0);
  assert.equal(await readFile(file, 'utf8'), original, 'Reading old cards must not rewrite statuses or dates');
  await page.getByRole('button', { name: 'Show menu', exact: true }).click();
  await expect(page.getByRole('button', { name: /Show archive \(2\)/ })).toBeVisible();
  await page.getByRole('button', { name: /Show archive \(2\)/ }).click();
  await expect(page.locator('.entity-card[data-entity="manual-archive"]')).toBeVisible();
  await page.getByRole('button', { name: /Hide archive \(2\)/ }).click();
  await page.getByRole('textbox', { name: 'Search entities' }).fill('manual-archive'); await expect(page.locator('.entity-card[data-entity="manual-archive"]')).toBeVisible(); await page.getByRole('button', { name: 'Clear search' }).click();
  await post('/settings', { selectedProjectId: project.id }); await expect(page.locator('.entity-card[data-entity="old-project"]')).toBeVisible(); await expect(page.locator('.entity-card[data-entity="old-active"]')).toHaveCount(0);
  await post('/settings', { selectedProjectId: null }); await expect(page.locator('.entity-card[data-entity="old-active"]')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for card old-active', exact: true }).click(); await page.getByRole('menuitem', { name: 'Archive card', exact: true }).click(); await expect(page.locator('.entity-card[data-entity="old-active"]')).toHaveCount(0);
  await page.goto(service.urls.workspace + '#/old-active'); await page.getByRole('button', { name: 'Actions for card old-active', exact: true }).click(); await page.getByRole('menuitem', { name: 'Restore card', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).entities.find(value => value.id === 'old-active').status).toBe('active');
  const restored = JSON.parse(await readFile(file, 'utf8')); const active = restored.entities.find(value => value.id === 'old-active'); assert.equal(active.status, 'active'); active.updated = '1990-01-01'; await writeFile(file, JSON.stringify(restored));
  await page.goto(service.urls.workspace); await expect(page.locator('.entity-card[data-entity="old-active"]')).toBeVisible(); await page.reload(); await expect(page.locator('.entity-card[data-entity="old-active"]')).toBeVisible();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).entities.find(value => value.id === 'manual-archive').status, 'archived');
  assert.deepEqual(errors, []); assert.equal(service.sessions.list().length, 0);
  console.log('PASS card visibility: old active/done/creation-only/pinned and project cards remain visible; explicit archive/search/restore persist, reload never rearchives and reads do not rewrite the registry. No native/model calls.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
