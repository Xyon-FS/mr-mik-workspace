// Visual contract for the approved Workspace/Files concept, using the real UI.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { seedWorkspaceFiles } from './workspace-files-ui.mjs';
import { selectControl } from './select-control.mjs';

export async function exerciseWorkspaceVisuals(page, fixture) {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1100, height: 850 });
  const shoot = async name => {
    await page.screenshot({ path: `.cache/workspace-visual-${name}.png` });
    for (const selector of ['dialog[open]', '.workspace-select-options:visible', '.workspace-popover:visible', '.workspace-file-menu:visible', '.hub-rail-content']) {
      const control = page.locator(selector).last();
      if (await control.isVisible()) { await control.screenshot({ path: `.cache/workspace-visual-${name}-detail.png` }); break; }
    }
  };
  const dialogSurface = async dialog => {
    await expect(dialog).toBeVisible();
    const style = await dialog.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius, rect: element.getBoundingClientRect().toJSON() }));
    assert.equal(style.background, 'rgb(21, 21, 28)'); assert.equal(style.radius, '12px');
    assert.ok(style.rect.x >= 0 && style.rect.right <= 1100);
    assert.ok(Math.abs(style.rect.x + style.rect.width / 2 - 550) <= 1 && Math.abs(style.rect.y + style.rect.height / 2 - 425) <= 1, 'Workspace dialogs are centered in their window');
  };
  const close = dialog => dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle projects', exact: true }).click();
  await selectControl(page, 'Active workspace', fixture.project.id);
  const scope = page.getByRole('combobox', { name: 'Active workspace', exact: true });
  await expect(scope).toBeVisible();
  await expect(scope.locator('.workspace-choice-icon')).toBeVisible();
  const icon = await scope.locator('.workspace-choice-icon').boundingBox();assert.ok(Math.abs(icon.width - 27) <= 1);
  await shoot('workspace');
  await scope.click();
  const options = page.getByRole('listbox', { name: 'Active workspace', exact: true });
  assert.equal(await options.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(21, 21, 28)');
  await shoot('workspace-picker'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await shoot('workspace-actions');
  await page.getByRole('dialog', { name: 'Workspace actions', exact: true }).getByRole('button', { name: 'Edit workspace', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit workspace', exact: true });await dialogSurface(dialog);
  const input = dialog.getByLabel('Name', { exact: true });
  assert.equal(await input.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(26, 25, 33)');
  assert.equal(await input.evaluate(element => getComputedStyle(element).borderRadius), '6px');
  await shoot('workspace-edit'); await close(dialog);
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New workspace', exact: true });await dialogSurface(dialog);await shoot('workspace-new');await close(dialog);
  await page.getByRole('button', { name: 'Link project', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Link project', exact: true });await dialogSurface(dialog);await shoot('project-link');await close(dialog);
  await page.getByRole('button', { name: 'Edit link for Secondary', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit linked project', exact: true });await dialogSurface(dialog);await shoot('project-edit');await close(dialog);
  await page.getByRole('button', { name: 'Unlink Main project', exact: true }).click();
  dialog = page.getByRole('alertdialog', { name: 'Unlink Main project?', exact: true });await dialogSurface(dialog);
  await page.getByRole('combobox', { name: 'New main linked project', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'New main linked project', exact: true })).toBeVisible();await expect(page.getByRole('listbox', { name: 'New main linked project', exact: true })).toHaveCSS('display','block');await shoot('project-unlink');await page.keyboard.press('Escape');await close(dialog);
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace actions', exact: true }).getByRole('button', { name: 'Remove workspace', exact: true }).click();
  dialog = page.getByRole('alertdialog', { name: 'Remove workspace registration?', exact: true });await dialogSurface(dialog);
  await page.getByRole('combobox', { name: 'What to do with these cards', exact: true }).click();await shoot('workspace-remove');await page.keyboard.press('Escape');await close(dialog);
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace actions', exact: true }).getByRole('button', { name: 'Workspace icon', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Workspace icon', exact: true });await dialogSurface(dialog);await shoot('icon-upload');
  await dialog.getByRole('button', { name: 'Generate with AI', exact: true }).click();await expect(dialog.getByRole('button',{name:'Use icon',exact:true})).toBeInViewport();await shoot('icon-generation');await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Toggle files', exact: true }).click();
  await shoot('files');await page.getByRole('combobox', { name: 'Filter collections', exact: true }).click();await shoot('collection-picker');await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Associations for Review notes', exact: true }).click();
  const association = page.getByRole('dialog', { name: 'Associations for Review notes', exact: true });
  await association.getByRole('combobox', { name: 'Workspace', exact: true }).click();
  await expect(association).toBeVisible();await expect(association.getByRole('listbox', { name: 'Workspace', exact: true })).toBeVisible();
  await shoot('association-workspaces');await page.keyboard.press('Escape');await expect(association).toBeVisible();
  await association.getByRole('combobox', { name: 'Linked project', exact: true }).click();await shoot('association-projects');await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create card', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New card', exact: true });await dialogSurface(dialog);await shoot('card-new');await close(dialog);
  await page.getByRole('button', { name: 'Browse files', exact: true }).click();
  await page.getByRole('combobox', { name: 'File browser root', exact: true }).click();await shoot('file-locations');await page.keyboard.press('Escape');
  await selectControl(page, 'File browser root', `${fixture.project.id}:primary`);
  await page.getByRole('button', { name: 'Actions for library.md', exact: true }).click();await shoot('file-actions');
  await page.getByRole('menuitem', { name: 'Move to Recycle Bin', exact: true }).click();
  dialog = page.getByRole('alertdialog', { name: 'Move to Recycle Bin?', exact: true });await dialogSurface(dialog);await shoot('file-recycle');await close(dialog);
  for (const [width, height] of [[700, 800], [390, 700], [320, 560]]) {
    await page.setViewportSize({ width, height });
    await selectControl(page, 'File browser root', 'custom-path');
    dialog = page.getByRole('dialog', { name: 'Go to folder', exact: true });
    const box = await dialog.boundingBox();assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
    await shoot(`custom-folder-${width}`);await close(dialog);
  }
  assert.deepEqual(errors, []);
  console.log('PASS visual contract: palette/radii, dark inputs, compact scope icon, styled nested selectors, all Workspace/Files dialogs and popovers, 320–1100px. No model calls.');
}

if (process.argv[1]?.endsWith('workspace-files-visual-ui.mjs')) {
  let browser;
  try {
    const base = await mkdtemp(path.join(os.tmpdir(), 'mik-workspace-visual-')), repo = path.join(base, 'Hub');
    for (const folder of ['workspace', 'context', 'knowledge', 'processes', 'inbox']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
    const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: path.join(base, 'home'), env: {} } });
    const fixture = await seedWorkspaceFiles(service, repo, base);
    browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });await page.goto(service.urls.workspace);
    await exerciseWorkspaceVisuals(page, fixture);
  } finally { await browser?.close();await cleanupFixtures(); }
}
