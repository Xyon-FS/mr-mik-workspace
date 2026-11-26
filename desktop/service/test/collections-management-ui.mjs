// Native picker/recycler are simulated only for this fixture; imports and JSON cleanup are real.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { seedWorkspaceFiles } from './workspace-files-ui.mjs';
import { selectControl } from './select-control.mjs';

let browser, page, service;
const pending = [], recycleErrors = [], recycled = [];
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-collections-management-')), repo = path.join(base, 'Hub');
  for (const folder of ['workspace', 'context', 'knowledge', 'processes', 'inbox', 'recycled']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: path.join(base, 'home'), env: {} }, native: event => {
    if (event.type !== 'recycle-file') return;
    const task = (async () => {
      const relative = path.relative(base, event.path);assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const target = path.join(repo, 'recycled', String(recycled.length));recycled.push({ from: event.path, target });await rename(event.path, target);
      if (event.requestId) service.nativeMessage({ type: 'card-recycle-result', requestId: event.requestId, recycled: true });
      else await page.evaluate(value => window.dispatchEvent(new CustomEvent('mrmak-recycle-result', { detail: { path: value, recycled: true } })), event.path);
    })().catch(error => { recycleErrors.push(error.message); if (event.requestId) service.nativeMessage({ type: 'card-recycle-result', requestId: event.requestId, recycled: false }); });
    pending.push(task);
  } });
  const fixture = await seedWorkspaceFiles(service, repo, base);
  browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } });page.setDefaultTimeout(10000);
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle files', exact: true }).click();await selectControl(page, 'Active workspace', fixture.project.id);
  let pickSource = '';
  await page.route('**/api/files/pick', async route => {
    const { requestId } = route.request().postDataJSON();await route.fulfill({ json: { requested: true } });
    await page.evaluate(value => window.dispatchEvent(new CustomEvent('mrmak-picked-files', { detail: value })), { requestId, paths: [pickSource] });
  });
  for (const [kind, label] of [['knowledge', 'Knowledge'], ['process', 'Processes'], ['inbox', 'Inbox']]) {
    pickSource = path.join(base, `added-${kind}.md`);await writeFile(pickSource, `# Added ${label}`);
    await page.getByRole('button', { name: `Add files to ${label}`, exact: true }).click();
    await expect(page.locator('.hub-tree').getByRole('button', { name: `added-${kind}.md`, exact: true })).toBeVisible();
    const resource = (await service.projects.resources(kind, fixture.project.id, 'project')).find(item => item.title === `added-${kind}.md`);assert.ok(resource);
    await service.projects.assignResource({ kind, path: resource.path, projectId: fixture.project.id });
    await page.getByRole('button', { name: `Actions for added-${kind}.md`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to Recycle Bin', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Move to Recycle Bin?', exact: true }).getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click();
    await expect(page.locator('.hub-tree').getByRole('button', { name: `added-${kind}.md`, exact: true })).toHaveCount(0);
    const metadata = kind === 'inbox' ? service.projects.inboxPath : service.projects.workspacePath;
    await expect.poll(async () => JSON.parse(await readFile(metadata, 'utf8')).resources.some(item => item.path === resource.path)).toBe(false);
    assert.equal(await readFile(pickSource, 'utf8'), `# Added ${label}`);
  }
  await selectControl(page, 'Filter collections', 'knowledge');
  await expect(page.getByRole('button', { name: 'Add files to Knowledge', exact: true })).toHaveCount(1);
  await selectControl(page, 'Filter collections', 'all');
  const card = await service.projects.createCard({ projectId: fixture.project.id, title: 'Delete fixture card' });
  await service.projects.addCardNote({ projectId: fixture.project.id, id: card.id, title: 'Owned page', text: 'Owned content' });
  const saved = service.sessions.make({ id: 'closed-associated', agent: 'codex', name: 'Retained history', cwd: fixture.project.repositoryPath, projectId: fixture.project.id, cardId: card.id, nativeId: 'retained-native-fixture', open: false });
  service.sessions.items.set(saved.id, saved);await service.sessions.persist();
  await page.locator('.hub-tree').getByRole('button', { name: 'Actions for card Delete fixture card', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete card…', exact: true }).click();
  let dialog = page.getByRole('alertdialog', { name: 'Delete “Delete fixture card”?', exact: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();assert.ok((await stat(path.join(repo, 'workspace', card.folder))).isDirectory());
  await page.locator('.hub-tree').getByRole('button', { name: 'Actions for card Delete fixture card', exact: true }).click();await page.getByRole('menuitem', { name: 'Delete card…', exact: true }).click();
  saved.open = true;service.sessions.changed(saved);
  const blocked = page.waitForResponse(response => response.url().endsWith('/api/cards/delete'));
  await dialog.getByRole('button', { name: 'Delete card', exact: true }).click();assert.equal((await blocked).status(), 409);
  await expect(dialog.getByRole('alert')).toContainText('Close');
  assert.ok(JSON.parse(await readFile(service.projects.workspacePath, 'utf8')).entities.some(item => item.id === card.id));
  saved.open = false;service.sessions.changed(saved);await service.sessions.persist();
  const deleted = page.waitForResponse(response => response.url().endsWith('/api/cards/delete'));
  await dialog.getByRole('button', { name: 'Delete card', exact: true }).click();assert.equal((await deleted).status(), 200);
  await expect(page.locator('.hub-tree').getByRole('link', { name: 'Delete fixture card', exact: true })).toHaveCount(0);
  assert.ok(!JSON.parse(await readFile(service.projects.workspacePath, 'utf8')).entities.some(item => item.id === card.id));
  assert.equal(await stat(path.join(repo, 'workspace', card.folder)).catch(() => null), null);
  assert.equal(service.sessions.get(saved.id).cardId, null);assert.equal(service.sessions.get(saved.id).nativeId, 'retained-native-fixture');
  const persisted = JSON.parse(await readFile(path.join(service.sessions.stateDir, 'sessions.json'), 'utf8')).find(item => item.id === saved.id);
  assert.equal(persisted.cardId, null);assert.equal(persisted.nativeId, 'retained-native-fixture');
  assert.equal(await readFile(fixture.source, 'utf8'), '# Library fixture');
  await page.getByRole('button', { name: 'Toggle projects', exact: true }).click();await page.getByRole('combobox', { name: 'Active workspace', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Active workspace', exact: true });
  const labels = await list.locator('.select-option-label').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
  assert.ok(Math.max(...labels) - Math.min(...labels) <= 1);await page.screenshot({ path: '.cache/collections-workspace-picker-fixed.png' });await page.keyboard.press('Escape');
  for (const [width, height] of [[1100, 850], [390, 700], [320, 560]]) {
    await page.setViewportSize({ width, height });await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'New workspace', exact: true });const box = await dialog.boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1 && Math.abs(box.y + box.height / 2 - height / 2) <= 1);
    await page.screenshot({ path: `.cache/collections-centered-${width}.png` });await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await Promise.all(pending);assert.deepEqual(recycleErrors, []);assert.deepEqual(errors, []);
  console.log('PASS collections management: add/remove Knowledge, Processes and Inbox; metadata cleanup; card delete/cancel with files and retained chat history; external originals preserved; centered dialogs; aligned workspace labels.');
} finally { await Promise.all(pending);await browser?.close();await cleanupFixtures(); }
