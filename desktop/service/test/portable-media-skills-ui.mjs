import { testBrowserEnvironment } from './fixtures.mjs';
// Production settings/HTTP, isolated Hub/native home; no model or auth calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-transfer-options-ui-'));
const previousCodexHome = process.env.CODEX_HOME;
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  process.env.CODEX_HOME = native;
  for (const folder of ['workspace', 'projects', 'inbox']) await mkdir(path.join(repo, folder), { recursive: true });
  await mkdir(path.join(native, 'sessions'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
  const external = path.join(base, 'external.png'), nativeId = randomUUID(), id = randomUUID();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
  await writeFile(external, image);
  await writeFile(path.join(native, 'sessions', `rollout-fixture-${nativeId}.jsonl`), [
    { type: 'session_meta', payload: { id: nativeId, cwd: repo } },
    { type: 'response_item', payload: { type: 'image_generation_call', result: external } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(path.join(repo, 'projects/skill-scopes.json'), JSON.stringify({ skills: { fixture: { global: false, projects: {} } } }));
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.accounts.inventory = async () => []; service.accounts.profileInventory = async () => [];
  service.coordinator.start = async () => { throw new Error('No model in this fixture'); };
  service.sessions.accountContext = async () => ({ sharedHome: native, privateHome: native, sqliteHome: native });
  service.sessions.items.set(id, service.sessions.make({ id, agent: 'codex', nativeId, cwd: repo, open: false, chatInterface: 'chat', hasConversation: true }));
  await service.sessions.persist();
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let picked = base;
  await page.route('**/api/files/pick', async route => {
    const { requestId } = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: '{"requested":true}' });
    await page.evaluate(({ requestId, picked }) => window.dispatchEvent(new CustomEvent('mrmak-picked-files', { detail: { requestId, paths: [picked] } })), { requestId, picked });
  });
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle settings', exact: true }).click();
  await page.getByRole('button', { name: 'Transfer Hub settings', exact: true }).click();
  const settings = page;
  await settings.getByRole('button', { name: 'Export · full', exact: true }).click();
  const include = settings.getByRole('checkbox', { name: 'Include external conversation files', exact: false });
  await expect(include).not.toBeChecked();
  await include.check();
  await settings.getByRole('button', { name: 'Confirm full export', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('Export saved:');
  const archive = (await readdir(base)).find(file => file.endsWith('.mrmak.zip')); assert.ok(archive); picked = path.join(base, archive);
  await rm(external);
  await writeFile(path.join(repo, 'projects/skill-scopes.json'), JSON.stringify({ skills: { fixture: { global: true, projects: {} } } }));
  await settings.getByRole('button', { name: 'Choose archive to import…', exact: true }).click();
  await expect(settings.getByText('Skill activation conflicts · keep local by default', { exact: true })).toBeVisible();
  const conflict = settings.getByRole('checkbox', { name: 'codex · fixture · Global', exact: false });
  await expect(conflict).not.toBeChecked();
  await conflict.check();
  await settings.getByRole('button', { name: 'Import into this Hub', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('Imported');
  assert.equal(JSON.parse(await readFile(path.join(repo, 'projects/skill-scopes.json'))).skills.fixture.global, false);
  // The actual asset HTTP route must resolve a missing old path through the
  // imported conversation-scoped index, not through a permissive filesystem root.
  const session = service.sessions.get(id);
  session.graphical = { items: new Map([['fixture-image', { path: external }]]), historyItems: new Map(), resultAssets: new Map(), previewPaths: new Set() };
  const response = await fetch(`${service.origin}/api/sessions/${id}/chatasset?item=fixture-image`, { headers: { Authorization: `Bearer ${service.token}` } });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.url, `data:image/png;base64,${image.toString('base64')}`);
  session.graphical = null;
  assert.deepEqual(errors, []);
  console.log('Transfer UI passed: optional media starts off, explicit inclusion exports, per-skill choice imports, old media path resolves through the actual HTTP asset route.');
} finally {
  try { await browser?.close(); await service?.close(); await cleanupFixtures(); }
  finally { if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome; }
}
