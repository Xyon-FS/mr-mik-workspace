// Failure, race and layout checks supplement the normal acceptance flow.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { seedWorkspaceFiles } from './workspace-files-ui.mjs';
import { selectControl } from './select-control.mjs';

export async function exerciseWorkspaceFilesReview(page, fixture) {
  const { project, other, repo } = fixture, errors = [], failures = [];
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
  const check = async (name, run) => { try { await run(); console.log('PASS', name); } catch (error) { failures.push({ name, error: error.message }); console.log('FAIL', name, error.message); await page.screenshot({ path: '.cache/workspace-files-review-failure.png' }).catch(() => {}); console.log('Recent UI events', await page.evaluate(() => window.__reviewEvents || []).catch(() => [])); } };
  await page.evaluate(() => { window.__reviewEvents = []; for (const type of ['pointerdown', 'focusin', 'click']) document.addEventListener(type, event => { const node = event.target; window.__reviewEvents.push({ type, tag: node.tagName, label: node.getAttribute?.('aria-label'), classes: node.className }); window.__reviewEvents = window.__reviewEvents.slice(-30); }, true); });
  const files = page.getByRole('button', { name: 'Toggle files', exact: true });
  if (await files.getAttribute('aria-pressed') !== 'true') await files.click();
  await selectControl(page, 'Active workspace', project.id);
  await expect(page.getByRole('button', { name: 'Associations for Review notes', exact: true })).toBeVisible();
  await check('association failures retain draft and do not change the card', async () => {
    await page.route('**/api/cards/assign', route => route.fulfill({ status: 409, json: { error: 'Fixture association refused' } }));
    try {
      await page.getByRole('button', { name: 'Associations for Review notes', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Associations for Review notes', exact: true });
      await selectControl(editor, 'Workspace', other.id);
      await selectControl(editor, 'Linked project', 'primary');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor.getByRole('alert')).toBeVisible();
      await expect(editor.getByLabel('Workspace', { exact: true })).toHaveAttribute('data-value', other.id);
      const registry = JSON.parse(await readFile(path.join(repo, 'workspace/workspace.json'), 'utf8'));
      assert.equal(registry.entities.find(item => item.title === 'Review notes').projectId, project.id);
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally { await page.unroute('**/api/cards/assign'); }
  });
  await check('association menus stay anchored and inside short narrow windows', async () => {
    for (const [width, height] of [[320, 560], [420, 600], [1100, 850]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: 'Associations for Review notes', exact: true }).click();
      const menu = page.getByRole('dialog', { name: 'Associations for Review notes', exact: true });
      await expect(menu).toBeVisible();
      const geometry = await menu.evaluate(element => ({ position: getComputedStyle(element).position, rect: element.getBoundingClientRect().toJSON() }));
      assert.equal(geometry.position, 'fixed');
      assert.ok(geometry.rect.x >= 0 && geometry.rect.right <= width && geometry.rect.y >= 0 && geometry.rect.bottom <= height, JSON.stringify(geometry));
      if (width === 1100) await page.screenshot({ path: '.cache/workspace-files-association-reviewed.png' });
      await page.keyboard.press('Escape');
    }
  });
  await page.setViewportSize({ width: 1100, height: 850 });
  await check('switching workspace never exposes rows from the previous workspace while loading', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/resources?**', async route => { if (new URL(route.request().url()).searchParams.get('projectId') === other.id) await gate; await route.continue(); });
    try {
      await selectControl(page, 'Active workspace', other.id);
      await expect(page.getByRole('combobox', { name: 'Active workspace', exact: true })).toHaveAttribute('data-value', other.id);
      await expect(page.locator('.hub-tree').getByRole('button', { name: 'library.md', exact: true })).toHaveCount(0, { timeout: 500 });
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
    await selectControl(page, 'Active workspace', project.id);
  });
  await check('failed unlink is visible in Main folders and retains the original', async () => {
    await page.route('**/api/resources?**', async route => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: data.map(item => ({ ...item, repositoryProjectId: project.id })) });
    });
    await page.route('**/api/resources/unlink', route => route.fulfill({ status: 409, json: { error: 'Fixture unlink refused' } }));
    try {
      await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
      await page.getByRole('button', { name: 'Actions for library.md', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Remove link from Hub', exact: true }).click();
      await page.getByRole('alertdialog', { name: 'Remove link from Hub?', exact: true }).getByRole('button', { name: 'Remove link', exact: true }).click();
      await expect(page.locator('.hub-rail-content').getByRole('alert')).toBeVisible({ timeout: 800 });
      assert.equal(await readFile(fixture.source, 'utf8'), '# Library fixture');
    } finally { await page.unroute('**/api/resources?**'); await page.unroute('**/api/resources/unlink'); }
  });
  await check('a cancelled failed editor does not leak its error into another editor', async () => {
    await page.getByRole('button', { name: 'Toggle projects', exact: true }).click();
    await page.route('**/api/projects', route => route.request().method() === 'POST' ? route.fulfill({ status: 409, json: { error: 'Fixture name refused' } }) : route.continue());
    try {
      await page.getByRole('button', { name: 'New workspace', exact: true }).click();
      const creation = page.getByRole('dialog', { name: 'New workspace', exact: true });
      await creation.getByLabel('Name', { exact: true }).fill('Rejected fixture');
      await creation.getByRole('button', { name: 'Create workspace', exact: true }).click();
      await expect(creation.getByRole('alert')).toBeVisible();
      await creation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
      await page.getByRole('dialog', { name: 'Workspace actions', exact: true }).getByRole('button', { name: 'Edit workspace', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Edit workspace', exact: true }).getByRole('alert')).toHaveCount(0);
    } finally { await page.unroute('**/api/projects'); await page.keyboard.press('Escape'); }
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
}

if (process.argv[1]?.endsWith('workspace-files-review-ui.mjs')) {
  let browser;
  try {
    const base = await mkdtemp(path.join(os.tmpdir(), 'mik-workspace-review-')), repo = path.join(base, 'Hub');
    for (const folder of ['workspace', 'context', 'knowledge', 'processes', 'inbox']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
    const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: path.join(base, 'home'), env: {} } });
    const fixture = await seedWorkspaceFiles(service, repo, base);
    browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.goto(service.urls.workspace);
    await writeFile('.cache/workspace-files-review-fixture.json', JSON.stringify({base,repo}));
    await exerciseWorkspaceFilesReview(page, fixture);
  } finally { await browser?.close(); await cleanupFixtures(); }
}
