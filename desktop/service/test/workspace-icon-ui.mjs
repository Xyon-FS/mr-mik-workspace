// Real application/service; native model calls are synthetic and isolated.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { iconPng } from './workspace-icon-fixture.mjs';

const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-workspace-icon-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), linked = path.join(base, 'linked'), generated = path.join(repo, 'generated.png');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(linked);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}'); await writeFile(generated, iconPng({ size: 256 }));
  await writeFile(path.join(linked, 'icon.png'), iconPng());
  service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(base, 'home'), env: {} }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const native = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    const runtime = new CodexChat({ ...options, spawnChild: native.spawnChild });
    const submit = runtime.submit.bind(runtime);
    runtime.submit = async text => {
      const result = await submit(text);
      runtime.items.set('generated-icon', { id: 'generated-icon', type: 'imageGeneration', status: 'completed', path: generated }); runtime.changed();
      return result;
    };
    return runtime;
  };
  const account = await service.profiles.create('Icon acceptance'), project = await service.projects.save({ name: 'Game workspace', repositoryPath: linked });
  const current = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: account.id, projectId: project.id, repositoryId: 'primary', cwd: linked, name: 'Original conversation' });
  await fetch(`${service.origin}/api/sessions/${current.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const rail = page.getByRole('button', { name: 'Game workspace projects', exact: true });
  await expect(rail.locator('img')).toHaveCount(0);
  const openIcon = async () => {
    const drawer = page.getByRole('complementary', { name: 'Conversations by project' });
    if (!await drawer.isVisible()) await rail.click();
    await drawer.getByRole('button', { name: 'Workspace actions for Game workspace', exact: true }).click();
    await page.getByRole('dialog', { name: 'Workspace actions for Game workspace', exact: true }).getByRole('button', { name: 'Workspace icon', exact: true }).click();
    return page.getByRole('dialog', { name: 'Workspace icon', exact: true });
  };
  let dialog = await openIcon();
  await dialog.getByLabel('Upload workspace icon', { exact: true }).setInputFiles({ name: 'opaque.png', mimeType: 'image/png', buffer: iconPng({ opaque: true }) });
  await expect(dialog.getByRole('alert')).toContainText('transparent background'); await expect(dialog.getByRole('button', { name: 'Use icon', exact: true })).toBeDisabled();
  await dialog.getByLabel('Upload workspace icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: iconPng() });
  await expect(dialog.getByRole('img', { name: 'Workspace icon preview', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, '.cache/workspace-icon-upload.png') });
  await dialog.getByRole('button', { name: 'Use icon', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(rail.locator('img')).toBeVisible(); await expect.poll(() => service.projects.get(project.id).then(project => !!project.iconRevision)).toBe(true);
  dialog = await openIcon(); await dialog.getByRole('button', { name: 'Generate with AI', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Codex account', exact: true }).click(); await dialog.getByRole('option', { name: 'Icon acceptance', exact: true }).click();
  await dialog.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Icon model', exact: true })).toBeEnabled();
  assert.equal(native.calls.filter(call => call.method === 'turn/start').length, 0);
  await dialog.getByRole('combobox', { name: 'Icon model', exact: true }).click(); await dialog.getByRole('option', { name: 'Fixture alternate', exact: true }).click();
  await page.screenshot({ path: path.join(root, '.cache/workspace-icon-generation.png') });
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Preview generated icon', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview generated icon', exact: true }).click(); await expect(dialog.getByRole('img', { name: 'Workspace icon preview', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Use icon', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const turns = native.calls.filter(call => call.method === 'turn/start'); assert.equal(turns.length, 1); assert.equal(turns[0].params.model, 'fixture-alternate');
  const generatedSession = [...service.sessions.items.values()].find(item => item.name === 'Workspace icon');
  await fetch(`${service.origin}/api/sessions/${generatedSession.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  const image = page.locator('.graphical-image').first(); await expect(image.getByRole('img')).toBeVisible(); await image.hover();await expect.poll(() => image.locator('.chat-image-footer').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  await expect(image.getByRole('button', { name: 'Open output in Workspace', exact: true })).toBeVisible();
  await expect(image.getByRole('button', { name: 'Add output to card', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, '.cache/chat-image-output-refined.png') });
  await image.getByRole('button', { name: 'Expand image', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Image viewer', exact: true });
  await viewer.getByRole('button', { name: 'Actual image size', exact: true }).click();
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();await expect(viewer.getByRole('status', { name: 'Image zoom' })).toHaveText('125%');
  await page.screenshot({ path: path.join(root, '.cache/chat-image-viewer-refined.png') });
  await viewer.getByRole('button', { name: 'Close image', exact: true }).click();
  await image.getByRole('button', { name: 'Use image as workspace icon', exact: true }).click(); dialog = page.getByRole('dialog', { name: 'Workspace icon', exact: true });
  await expect(dialog.getByRole('img', { name: 'Workspace icon preview', exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Icon workspace', exact: true }).click(); await dialog.getByRole('option', { name: 'Game workspace', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); dialog = await openIcon(); const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.screenshot({ path: path.join(root, `.cache/workspace-icon-${width}.png`) });
    await dialog.getByRole('button', { name: 'Reset initials', exact: true }).click(); await expect(dialog).toHaveCount(0);
    if (width === 390) { await expect(rail.locator('img')).toHaveCount(0); dialog = await openIcon(); await dialog.getByLabel('Upload workspace icon', { exact: true }).setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: iconPng() }); await dialog.getByRole('button', { name: 'Use icon', exact: true }).click(); }
  }
  assert.deepEqual(errors, []); assert.equal(native.calls.filter(call => call.method === 'turn/start').length, 1);
  console.log('PASS workspace-owned upload/reset, real transparency validation, immediate rail refresh, native model/account selection without inference, one synthetic generation, image result application, modal dropdowns, image toolbar and 320/390px layout. No live accounts or paid prompts.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
