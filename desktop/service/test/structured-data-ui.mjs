// Executable slider, isolation boundaries and state against production browser UI.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-structured-ui-')), root = path.resolve('.'), at = process.argv.indexOf('--portable'), portable = at < 0 ? null : path.resolve(process.argv[at + 1]);
const runtimeRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
let browser, service; const wires = [];
try {
 const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
 service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
 service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
 const profile = await service.profiles.create('Interactive fixture'), codex = graphicalFixture();
 service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild }); const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
 browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
 const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }), page = await context.newPage(), workspace = await context.newPage();
 const errors = []; for (const tab of [page, workspace]) tab.on('pageerror', error => errors.push(error.message));
 await workspace.goto(service.urls.workspace);
 const json = JSON.stringify({ name: '<script>window.dataExecuted=true</script>', nested: { enabled: true }, items: Array.from({ length: 120 }, (_, index) => index) });
 const csv = 'name,note\nAda,"one, two"\nLin,"line one\nline two"', tsv = 'name\tvalue\nAda\t42';
 for (const [name, text] of [['data.json', json], ['data.csv', csv], ['data.tsv', tsv]]) await writeFile(path.join(repo, name), text);
 await writeFile(path.join(repo, 'large.json'), JSON.stringify({ payload: 'x'.repeat(200000) }));
 for (const agent of ['codex', 'claude']) {
  const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} structured`, ...(agent === 'codex' ? { accountProfileId: profile.id } : {}) }), runtime = service.sessions.get(session.id).graphical;
  const item = { id: 'structured', type: 'agentMessage', text: [['json', json], ['csv', csv], ['tsv', tsv], ['json', '{"incomplete"'], ['csv', 'name,value\n' + Array.from({ length: 125 }, (_, index) => `row ${index},${index}`).join('\n')]].map(([language, value]) => `\`\`\`${language}\n${value}\n\`\`\``).join('\n\n') + '\n\n[JSON file](data.json) · [CSV file](data.csv) · [TSV file](data.tsv) · [Large JSON file](large.json)', turnId: 'turn', status: 'completed', details: '' };
  if (agent === 'codex') runtime.items = new Map([[item.id, item]]); else runtime.protocol.state.items = [item]; runtime.changed();
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); await page.goto(service.urls.chats);
  const options = page.getByRole('dialog', { name: 'Output options', exact: true });
  const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), blocks = chat.locator('.graphical-code'), tree = blocks.nth(0), draft = chat.locator('textarea').first(); await draft.fill('Keep structured draft');
  await expect(tree.getByRole('region', { name: 'Structured JSON' })).toBeVisible();
  await tree.locator('summary').filter({ hasText: /^nested/ }).click(); await expect(tree.locator('.structured-json-value.boolean')).toHaveText('true');
  const array = tree.locator('.structured-json-node').filter({ has: page.locator(':scope > summary').filter({ hasText: /^items/ }) });
  await tree.locator('summary').filter({ hasText: /^items/ }).click(); await expect(array.locator('.structured-json-leaf')).toHaveCount(50); await array.getByRole('button', { name: 'Show next 50', exact: true }).click(); await expect(array.locator('.structured-json-leaf')).toHaveCount(100);
  await tree.getByLabel('Output options', { exact: true }).click(); await options.getByRole('button', { name: 'Code', exact: true }).click(); await expect(tree.locator('pre')).toContainText(json); await tree.getByRole('button', { name: 'Copy code', exact: true }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), json);
  await tree.getByLabel('Output options', { exact: true }).click(); await options.getByRole('button', { name: 'Data', exact: true }).click(); assert.equal(await page.evaluate(() => window.dataExecuted), undefined);
  await page.setViewportSize({ width: 390, height: 900 }); await tree.screenshot({ path: path.join(root, `.cache/${agent}-json-tree-390.png`) }); await page.setViewportSize({ width: 1100, height: 900 });
  await tree.getByRole('button', { name: 'Copy code', exact: true }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), json);
  await expect(blocks.nth(1).getByRole('cell', { name: 'one, two', exact: true })).toBeVisible(); await expect(blocks.nth(2).getByRole('cell', { name: '42', exact: true })).toBeVisible(); await expect(blocks.nth(3).locator('pre')).toContainText('{"incomplete"'); await expect(blocks.nth(3).getByRole('button', { name: 'Data', exact: true })).toHaveCount(0);
  await expect(blocks.nth(1).getByRole('cell').filter({ hasText: 'line one' })).toHaveCSS('white-space', 'pre-wrap');
  const downloaded = page.waitForEvent('download'); await blocks.nth(1).getByLabel('Output options', { exact: true }).click(); await options.getByRole('button', { name: 'Download code', exact: true }).click(); const download = await downloaded; assert.equal(download.suggestedFilename(), 'code.csv'); const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString('utf8'), csv);
  await expect(blocks.nth(4).getByRole('row')).toHaveCount(51); await blocks.nth(4).getByRole('button', { name: 'Show next 50 rows', exact: true }).click(); await expect(blocks.nth(4).getByRole('row')).toHaveCount(101);
  const chart = blocks.nth(4);
  await chart.getByText('Explore data', { exact: true }).click();
  await chart.getByRole('button', { name: 'Bar chart', exact: true }).click();
  await expect(chart.locator('.structured-chart rect').first()).toHaveAttribute('height', '0');
  const activeAccent = await page.evaluate(() => document.documentElement.dataset.accentTheme);
  await page.evaluate(() => { document.documentElement.dataset.accentTheme = 'teal'; });
  await expect(chart.locator('.structured-chart rect').first()).toHaveCSS('fill', 'rgb(121, 216, 198)');
  await page.evaluate(accent => { document.documentElement.dataset.accentTheme = accent || 'rose'; }, activeAccent);
  await chart.getByRole('textbox', { name: 'Filter table rows' }).fill('row 0');
  await chart.getByRole('button', { name: 'Line chart', exact: true }).click();
  await expect(chart.locator('.structured-chart circle')).toHaveCount(1);
  await expect(chart.locator('.structured-chart text').filter({ hasText: /^row 0$/ })).toHaveCount(1);
  const active = workspace.locator('.workspace-preview-slot:not([hidden]) .file-preview');
  await tree.getByRole('button', { name: 'Open code in Workspace' }).click(); await expect(active.getByRole('region', { name: 'Structured JSON' })).toBeVisible();
  for (const [label, expected] of [['JSON', 'Root'], ['CSV', 'one, two'], ['TSV', '42']]) {
   await chat.getByRole('link', { name: `${label} file`, exact: true }).click(); await expect(active).toContainText(expected); await expect(active.getByLabel('Output options', { exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 900 }); await workspace.setViewportSize({ width: 520, height: 900 });
  assert.ok(await chat.evaluate(el => el.scrollWidth <= el.clientWidth+1)); await expect(draft).toHaveValue('Keep structured draft'); await workspace.screenshot({ path: path.join(root, `.cache/${agent}-structured-workspace.png`) }); await page.screenshot({ path: path.join(root, `.cache/${agent}-structured-chat.png`) }); await page.setViewportSize({ width: 1100, height: 900 });
  await chat.getByRole('link', { name: 'Large JSON file', exact: true }).click(); await expect(active.locator('pre')).toContainText('"payload":'); await expect(active.getByRole('button', { name: 'Data', exact: true })).toHaveCount(0);
 }
 assert.deepEqual(errors, []); assert.equal(codex.calls.some(call => call.method === 'turn/start'), false); assert.equal(wires.flatMap(wire => wire.calls).some(call => call.type === 'user'), false);
 console.log('PASS Codex/Claude JSON tree with bounded expansion, CSV/TSV tables, exact source/copy, invalid source fallback, inert HTML strings, Workspace blocks/files and narrow draft retention. Zero model calls.');
} finally { await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
