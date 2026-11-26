import { testBrowserEnvironment } from './fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await cp(path.join(root,'public/assets'),path.join(root,'dist/assets'),{recursive:true});
const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-theme-ui-'));
const repo = path.join(base, 'hub'), home = path.join(base, 'home');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await mkdir(path.join(repo, 'context'), { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
await writeFile(path.join(repo, 'context', 'goals.md'), '# Goals\n');
const service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home, env: {} } });
let browser;
try {
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  for (const name of ['New Codex chat', 'New Claude chat']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.waitFor();
    assert.equal(await button.textContent(), '');
    assert.equal(await button.locator('svg').count(), 2);
    assert.equal(await button.getAttribute('title'), name);
  }
  const samples = [];
  const colour = (locator, property = 'color') => locator.evaluate((el, property) => getComputedStyle(el)[property], property);
  for (const theme of ['rose', 'violet', 'blue', 'teal']) {
    await page.getByRole('button', { name: 'Toggle settings', exact:true }).click();
    await page.getByRole('button', { name: 'Appearance settings', exact:true }).click();
    await page.getByRole('button', { name: `${theme[0].toUpperCase()}${theme.slice(1)} accent`, exact:true }).click();
    await page.waitForFunction(theme => document.documentElement.dataset.accentTheme === theme, theme);
    const appearance = page.getByRole('dialog', {name:'Appearance settings',exact:true});
    const popup = await colour(appearance, 'backgroundColor');
    const slider = await appearance.getByRole('slider').evaluate(el => getComputedStyle(el, '::-webkit-slider-thumb').backgroundColor);
    const category = await colour(page.getByRole('button',{name:'Appearance settings',exact:true}), 'borderLeftColor');
    await page.screenshot({path:path.join(root,`.cache/theme-${theme}-settings.png`)});
    await page.getByRole('button', {name:'Close settings details',exact:true}).click();
    await page.getByRole('button', {name:'Toggle projects',exact:true}).click();
    const workspace = await colour(page.locator('.hub-rail-content'), 'backgroundColor');
    const badge = await colour(page.locator('.hub-workspace-select .workspace-choice-icon'), 'backgroundColor');
    await page.getByRole('combobox',{name:'Active workspace',exact:true}).click();
    const options = await colour(page.getByRole('listbox'), 'backgroundColor');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'New workspace',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'New workspace',exact:true});
    const modal = await colour(dialog,'backgroundColor');
    const input = await colour(dialog.getByRole('textbox').first(),'backgroundColor');
    const primary = await colour(dialog.getByRole('button',{name:'Create workspace',exact:true}),'backgroundColor');
    await page.screenshot({path:path.join(root,`.cache/theme-${theme}-dialog.png`)});
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Toggle files',exact:true}).click();
    await page.getByRole('button',{name:'Main folders',exact:true}).click();
    const files = await colour(page.locator('.file-mode button.selected'),'backgroundColor');
    const rail = await colour(page.locator('.files-rail .rail-tool.active'),'backgroundColor');
    await page.getByRole('combobox',{name:'Filter collections',exact:true}).click();
    const filesOptions = await colour(page.getByRole('listbox'),'backgroundColor');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Toggle skills',exact:true}).click();
    const skills = await colour(page.locator('.skill-agent-tabs button[aria-pressed=true]'));
    await page.getByRole('button',{name:'Toggle mcp',exact:true}).click();
    const tools = await colour(page.locator('.tools-kind-tabs button[aria-pressed=true]'),'backgroundColor');
    await page.screenshot({path:path.join(root,`.cache/theme-${theme}-tools.png`)});
    const semantic = await page.evaluate(() => {
      const dialog = document.createElement('dialog');dialog.className='workspace-native-dialog';
      const error = document.createElement('p');error.className='desk-error-inline';dialog.append(error);document.body.append(dialog);
      const color=getComputedStyle(error).color;dialog.remove();return color;
    });
    samples.push({theme,popup,slider,category,workspace,badge,options,modal,input,primary,files,rail,filesOptions,skills,tools,semantic});
    await page.getByRole('button',{name:'Toggle mcp',exact:true}).click();
  }
  for (const property of ['popup','slider','category','workspace','badge','options','modal','input','primary','files','rail','filesOptions','skills','tools'])
    assert.equal(new Set(samples.map(item=>item[property])).size,4,`${property} follows every theme`);
  for(const sample of samples){assert.equal(sample.popup,sample.workspace,'Anchored popup and rail share the theme');assert.equal(sample.modal,sample.workspace,'Native dialog inherits root palette');assert.equal(sample.options,sample.filesOptions,'Portal lists share the theme');}
  assert.equal(new Set(samples.map(item=>item.semantic)).size,1,'Error colours remain semantic');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-accent-theme','teal');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'Icon shortcuts and all four folder/panel/menu themes passed in an isolated Hub.', screenshots: path.join(root,'.cache/theme-*.png'), samples }));
} finally { await browser?.close(); await cleanupFixtures(); }
