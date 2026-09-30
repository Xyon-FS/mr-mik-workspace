import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repo = await mkdtemp(path.join(root, '.cache/demo-ui-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
await cp(path.join(root, 'public/assets'), path.join(root, 'dist/assets'), { recursive: true });
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: repo, env: {} } });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultNavigationTimeout(30000);
  await page.route('https://fonts.googleapis.com/**', route => route.abort()); await page.route('https://fonts.gstatic.com/**', route => route.abort());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Toggle projects' }).click();
  await page.getByRole('button', { name: 'Add example workspace' }).click();
  await page.getByRole('button', { name: 'Workspace · Mik’s Midnight Workshop', exact: true }).waitFor();
  const cards = JSON.parse(await readFile(service.projects.workspacePath, 'utf8')).entities;
  assert.equal(cards.length, 4);
  if (await page.getByRole('button', { name: 'Close Workspaces' }).isVisible()) await page.getByRole('button', { name: 'Close Workspaces' }).click();
  for (const width of [1280, 540]) {
    await page.setViewportSize({ width, height: 900 });
    for (const card of cards) for (let index = 0; index < card.steps.length; index++) {
      await page.goto(`${service.urls.workspace}#/${card.id}/${index}`, { waitUntil: 'domcontentloaded' });
      const frame = page.frameLocator('iframe.report-frame'); await frame.getByRole('heading', { level: 1 }).waitFor();
      assert.equal(await page.locator('.topbar [role="tab"]').count(), 0, 'Content navigation must not appear in the external banner');
      assert.equal(await page.locator('.content [role="tab"]').count(), card.steps.length > 1 ? card.steps.length : 0);
      if (card.steps.length > 1) {
        await page.getByRole('tab', { name: card.steps[index].name, exact: true }).click();
        await frame.getByRole('heading', { level: 1 }).waitFor();
      }
      const action = page.locator('.topbar-right .card-actions-trigger');
      assert.equal(await action.locator('svg circle').count(), 3, 'Actions icon must have visible dots');
      assert.equal(await page.locator('.topbar-right').evaluate(element => element.lastElementChild?.classList.contains('card-actions-wrap')), true, 'Actions must sit at the right end');
      if (card.category === 'project' && index === 0) {
        await action.click();
        assert.equal(await page.getByRole('menuitem', { name: 'Archive card', exact: true }).locator('svg').count(), 1);
        assert.equal(await page.getByRole('menuitem', { name: 'Delete card…', exact: true }).locator('svg').count(), 1);
        await page.screenshot({ path: path.join(repo, `${width}-actions.png`) });
        await page.keyboard.press('Escape');
      }
      assert.ok(await frame.getByRole('heading', { level: 2 }).count() >= 3);
      assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= innerWidth + 2), true, `${card.title}: horizontal overflow at ${width}`);
      await frame.getByRole('navigation', { name: 'Page sections' }).locator('a').last().click();
      if (card.category === 'image-gen') {
        await frame.getByRole('img').click(); await frame.getByRole('dialog').waitFor();
        await frame.getByRole('button', { name: 'Close', exact: true }).click();
        const downloading = page.waitForEvent('download');
        await frame.getByRole('link', { name: 'Download the SVG source ↓' }).click();
        assert.equal((await downloading).suggestedFilename(), 'espresso-cart.svg');
      }
      await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(repo, `${width}-${card.category}-${index}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Workspace · Mik’s Midnight Workshop', exact: true }).click();
  await page.screenshot({ path: path.join(repo, 'overview.png') });
  assert.deepEqual(errors, []);
  console.log(`Five demo pages and four cards passed wide/narrow previews, section links and local image preview: ${repo}`);
} finally { await browser?.close(); await service.close(); }
