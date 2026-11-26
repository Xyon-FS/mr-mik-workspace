import { testBrowserEnvironment } from './fixtures.mjs';
// Production settings UI, isolated Hub and synthetic account inventory. No CLI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { selectControl } from './select-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(root, '.cache/settings-defaults-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home: path.join(base, 'home'), env: {} } });
  service.accounts.inventory = async () => []; service.accounts.profileInventory = async () => [];
  const project = await service.projects.save({ name: 'Selector fixture' });
  let nativeStarts = 0;
  service.coordinator.start = async () => { nativeStarts++; throw new Error('System account is not available'); };
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace); await page.getByRole('button', { name: 'Toggle settings', exact: true }).click();
  await page.getByRole('button', { name: 'Chats settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Chats settings', exact: true });
  for(const [label,value,key,expected] of [['Terminal text size','15','terminalFontSize',15],['Terminal appearance','original','terminalAppearance','original']]) {
    await selectControl(page,label,value);await expect.poll(()=>service.coordinator.settings()[key]).toBe(expected);
  }
  const choose = async agent => settings.getByRole('group',{name:'Default provider',exact:true}).getByRole('button',{name:agent,exact:true}).click();
  await choose('Codex');
  for(const [label,value,key,expected] of [['Worker reasoning level','high','defaultWorkerEffort','high'],['Coordinator reasoning','xhigh','coordinatorEffort','xhigh'],['Codex permissions','auto-review','defaultCodexPermissions','auto-review']]) {
    await selectControl(page,label,value);await expect.poll(()=>service.coordinator.settings()[key]).toBe(expected);
  }
  await choose('Claude');await selectControl(page,'Worker reasoning level','max');await selectControl(page,'Claude permissions','bypass');
  await expect.poll(()=>service.coordinator.settings().defaultClaudeWorkerEffort).toBe('max');await expect.poll(()=>service.coordinator.settings().defaultClaudePermissions).toBe('bypass');
  assert.equal(service.coordinator.settings().defaultBypass,false);
  await choose('Codex');await expect(settings.getByRole('combobox',{name:'Worker reasoning level',exact:true})).toContainText('High');await expect(settings.getByRole('combobox',{name:'Codex permissions',exact:true})).toContainText('Approve for me');
  await page.reload();await page.getByRole('button',{name:'Toggle settings',exact:true}).click();await page.getByRole('button',{name:'Chats settings',exact:true}).click();await choose('Claude');
  await expect(settings.getByRole('combobox',{name:'Worker reasoning level',exact:true})).toContainText('Max');
  await expect(settings.getByRole('combobox',{name:'Claude permissions',exact:true})).toContainText('Bypass');
  await page.setViewportSize({width:390,height:844});assert.ok(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.setViewportSize({width:1100,height:1000});
  await page.getByRole('button',{name:'Transfer Hub settings',exact:true}).click();await expect(page.getByRole('button',{name:'Export · full',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Export · light',exact:true})).toBeVisible();
  assert.equal(nativeStarts,0);assert.deepEqual(errors,[]);
  const legacyId = randomUUID();
  const legacy = service.sessions.make({ id: legacyId, agent: 'kimi', name: 'Saved Kimi fixture', cols: 90, rows: 32, cwd: repo, status: 'stopped', open: false, hasConversation: true, createdAt: new Date().toISOString() });
  service.sessions.items.set(legacyId, legacy);
  await writeFile(path.join(service.sessions.stateDir, `screen-${legacyId}.json`), JSON.stringify({ data: 'Preserved Kimi UI fixture history\r\n' }));
  const response = await fetch(`${service.origin}/api/sessions/${legacyId}/resume`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(response.ok); assert.equal((await response.json()).status, 'stopped');
  const chats = await browser.newPage(); chats.on('pageerror', error => errors.push(error.message)); await chats.goto(service.urls.chats);
  await expect(chats.getByText('Saved Kimi chat · read only', { exact: true })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0);
  assert.equal(legacy.process, null);
  await chats.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(chats.locator('.agent-picker').getByRole('button', { name: /Kimi/ })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: shared dark workspace/settings selectors, persistence, Escape/outside dismissal; reasoning defaults editable without native startup; no Hub path and transfer controls retained.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
