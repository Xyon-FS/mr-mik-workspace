// Isolated production UI with native-shaped synthetic transport. No account/model/PTY.
import assert from 'node:assert/strict';
import { revealProcessFor } from './chat-disclosure-ui.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(root, '.cache/graphical-advanced-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), nativeHome = path.join(home, '.codex'), uiDir = path.join(base, 'ui');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(nativeHome, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(nativeHome, 'config.toml'), '# Synthetic fixture\n');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: false } });
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { ...process.env, CODEX_HOME: nativeHome } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Advanced fixture account');
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({}); service.accounts.status = async () => 'logged-in';
  const transport = graphicalFixture({ approval: true });
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', name: 'Advanced fixture', chatInterface: 'chat', accountProfileId: profile.id, codexPermissions: 'auto-review', effort: 'medium', cwd: repo });
  const runtime = service.sessions.get(session.id).graphical, child = transport.children[0], permissions = runtime.session.codexPermissions;
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' }); const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true }); await expect(chat).toBeVisible();
  const mode = chat.getByRole('combobox', { name: 'Model and reasoning', exact: true }); await expect(mode).toBeEnabled(); await expect(mode).toContainText('Build'); await mode.click();
  await expect(page.getByRole('radiogroup', { name: 'Work mode', exact: true }).getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('option', { name: 'Native mode', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Plan', exact: true }).click(); await expect(mode).toContainText('Plan'); await page.keyboard.press('Escape');
  assert.equal(runtime.session.codexPermissions, permissions); assert.equal(runtime.session.effort, 'medium');
  const permission = chat.getByRole('combobox', { name: 'Codex permissions', exact: true });
  for (const [label, value] of [['Ask for approval', 'ask'], ['Approve for me', 'auto-review']]) {
    await permission.click(); await page.getByRole('option', { name: label, exact: true }).click();
    await expect.poll(() => service.sessions.get(session.id).launchedCodexPermissions).toBe(value);
    await expect(permission).toBeEnabled(); await expect(mode).toBeEnabled();
    await expect(chat.getByRole('combobox', { name: 'Model and reasoning', exact: true })).toBeEnabled();
    assert.equal(service.sessions.get(session.id).graphical, runtime); assert.equal(child.closed, undefined);
  }
  assert.equal(transport.calls.some(call => call.method === 'thread/resume'), false);
  await expect(chat.getByText('Permissions pending', { exact: true })).toHaveCount(0);
  const details = chat.locator('.graphical-details'); await chat.getByLabel('Chat details', { exact: true }).click();
  await details.getByRole('tab',{name:'Context',exact:true}).click(); const usage = details.locator('.graphical-usage'); await expect(usage.locator('summary')).toHaveCount(0); await expect(details).toHaveAttribute('open'); await expect(usage).toContainText('Not measured yet'); await expect(usage.getByRole('meter')).toHaveCount(0);
  child.notify('thread/tokenUsage/updated', { threadId: runtime.threadId, tokenUsage: { last: { inputTokens: 32000, outputTokens: 400 }, total: { totalTokens: 80000 }, modelContextWindow: 128000 } });
  await expect(usage).toContainText('25%'); await expect(usage).toContainText(/32[.,]000 \/ 128[.,]000/);
  assert.equal(transport.calls.some(call => call.method === 'account/rateLimits/read'), false);
  await page.keyboard.press('Escape'); await chat.getByRole('combobox', { name: 'Model and reasoning', exact: true }).click();
  await page.getByRole('button',{name:'Account usage',exact:true}).click(); const limits = page.getByRole('dialog', { name: 'Model and reasoning', exact: true }).getByRole('region', { name: 'Account limits', exact: true }); await limits.getByRole('button', { name: 'Refresh account usage', exact: true }).click(); await expect(limits).toContainText('25% used');
  await page.keyboard.press('Escape'); await chat.getByLabel('Chat details', { exact: true }).click();
  await page.setViewportSize({ width: 650, height: 1050 });
  const usageBounds = await details.locator(':scope > div').boundingBox(); assert.ok(usageBounds.x >= 0 && usageBounds.x + usageBounds.width <= 650);
  for (const viewport of [{ width: 650, height: 1050 }, { width: 430, height: 850 }]) {
    await page.setViewportSize(viewport);
    const panel = await details.locator(':scope > div').boundingBox();
    assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height);
    for (const [section, region] of [['Context', usage], ['Session', details.getByRole('region', { name: 'Actions', exact: true })], ['Actions', details.getByRole('region', {name:'Conversation actions',exact:true})]]) {
      await details.getByRole('tab', { name: section, exact: true }).click(); await expect(region).toBeVisible(); const box = await region.boundingBox(); assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1);
    }
    await details.getByRole('tab', { name: 'Context', exact: true }).click(); await expect(details.getByRole('button', { name: 'Compact context', exact: true })).toBeVisible();
    await details.getByRole('tab', { name: 'Session', exact: true }).click(); await expect(details.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
    assert.equal(await details.locator('.graphical-detail-panel:not([hidden]) details').count(), 0, 'No nested submenu is needed');
  }
  await page.setViewportSize({ width: 650, height: 1050 });
  await page.screenshot({ path: path.join(root, '.cache/chat-organized-menu-20261018.png') });
  await page.setViewportSize({ width: 1280, height: 1050 });
  await chat.locator('.graphical-messages').click({ position: { x: 20, y: 20 } }); await expect(details).not.toHaveAttribute('open');
  await chat.getByLabel('Chat details', { exact: true }).click(); await chat.getByLabel('Chat details', { exact: true }).press('Escape'); await expect(usage).not.toHaveAttribute('open');
  await chat.getByLabel('Chat details', { exact: true }).click();
  await details.getByRole('tab', { name: 'Context', exact: true }).click(); await expect(usage).toBeVisible(); await expect(details).toHaveAttribute('open'); await expect(details.locator('[aria-label=Connected]')).toHaveCount(1);await details.getByRole('tab',{name:'Session',exact:true}).click(); await expect(details.getByRole('region', { name: 'Session', exact: true })).toContainText('Account');
  await page.screenshot({ path: path.join(root, '.cache/codex-chat-details-refined.png') });
  await chat.locator('.graphical-messages').click({ position: { x: 20, y: 20 } }); await expect(details).not.toHaveAttribute('open');
  const composer = chat.getByRole('textbox', { name: 'Message Codex', exact: true }); await composer.fill('Create a plan'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toBeVisible(); const turnId = runtime.turnId;
  child.notify('turn/plan/updated', { threadId: runtime.threadId, turnId, explanation: 'Synthetic plan', plan: [{ step: 'Inspect project', status: 'completed' }, { step: 'Prepare implementation', status: 'inProgress' }] });
  const plan = chat.getByRole('region', { name: 'Agent plan', exact: true });
  const planGroup = chat.locator('.graphical-work-group').filter({ has: page.locator(`[data-chat-item="plan-${turnId}"]`) });
  await revealProcessFor(planGroup); await planGroup.locator(':scope > summary').click();
  await expect(plan).toContainText('Plan · 1/2'); await expect(plan.locator('li[data-state="inProgress"]')).toContainText('Prepare implementation');
  // Legacy saved queues remain reviewable, but new composer input only steers.
  runtime.advanced.pause(true); runtime.advanced.enqueue('Queued follow-up', 'legacy-queue-fixture-0001');
  const queue = chat.getByRole('region', { name: 'Queued messages', exact: true }); await expect(queue).toContainText('Queued follow-up');
  for(let index=0; index<3; index++) runtime.advanced.enqueue(`Layout queued ${index}`, `layout-queue-fixture-000${index}`);
  await expect(queue.locator('li')).toHaveCount(4);
  for(const size of [{width:390,height:420},{width:650,height:480}]) {
    await page.setViewportSize(size);
    const geometry=await chat.locator('.graphical-composer').boundingBox();
    assert.ok(geometry.y+geometry.height<=size.height,'Saved Codex queue retains composer at minimum height');
    const control=queue.getByRole('button',{name:'Edit',exact:true}).first();await control.focus();
    assert.ok(await control.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.graphical-support').getBoundingClientRect();return Math.min(r.bottom,p.bottom)-Math.max(r.top,p.top)>=r.height-1}),'Saved queue controls remain reachable');
    await page.screenshot({path:path.resolve(`.cache/continued-codex-queue-${size.width}-${size.height}-after.png`)});
  }
  await page.setViewportSize({width:1280,height:1050});
  for(let index=0; index<3; index++) await queue.locator('li').filter({hasText:`Layout queued ${index}`}).getByRole('button',{name:'Remove',exact:true}).click();
  await expect(queue.locator('li')).toHaveCount(1);
  await queue.getByRole('button', { name: 'Edit', exact: true }).click(); await queue.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('Edited queued follow-up');
  await queue.getByRole('button', { name: 'Save', exact: true }).click();
  runtime.advanced.enqueue('Remove queued follow-up', 'legacy-queue-fixture-0002'); await expect(queue.locator('li')).toHaveCount(2);
  await queue.locator('li').filter({ hasText: 'Remove queued follow-up' }).getByRole('button', { name: 'Remove', exact: true }).click(); await expect(queue.locator('li')).toHaveCount(1);
  await expect(chat.getByRole('combobox', { name: 'Follow-up behavior', exact: true })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toBeEnabled();
  await expect(chat.locator('.graphical-primary-action')).toHaveCount(1);
  child.notify('serverRequest/resolved', { threadId: runtime.threadId, requestId: 900 }); await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toHaveCount(0);
  await composer.fill('Preserve navigation'); await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(root, '.cache/chat-composer-steer-20261018.png') });
  await composer.press('Enter'); await expect(composer).toHaveValue('');
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toBeVisible();
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  const steer = transport.calls.find(call => call.method === 'turn/steer'); assert.equal(steer.params.expectedTurnId, turnId); assert.equal(steer.params.input[0].text, 'Preserve navigation');
  await page.setViewportSize({ width: 650, height: 1100 }); await page.screenshot({ path: path.join(root, '.cache/chat-composer-stop-narrow-20261018.png') });
  const regionBounds = await chat.boundingBox(); assert.ok(regionBounds.width <= 650);
  await page.setViewportSize({ width: 1280, height: 1050 });
  await chat.getByRole('button', { name: 'Interrupt response', exact: true }).click(); await expect(queue).toContainText('paused');
  await queue.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await expect.poll(() => transport.calls.filter(call => call.method === 'turn/start').length).toBe(2);
  await expect(queue).toHaveCount(0); await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toBeVisible();
  const second = transport.calls.filter(call => call.method === 'turn/start')[1]; assert.equal(second.params.input[0].text, 'Edited queued follow-up'); assert.equal(second.params.collaborationMode.mode, 'plan');
  await chat.getByRole('button', { name: 'Decline', exact: true }).click(); await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await permission.click(); await page.getByRole('option', { name: 'Ask for approval', exact: true }).click();
  await expect.poll(() => service.sessions.get(session.id).launchedCodexPermissions).toBe('ask');
  await expect(mode).toBeEnabled(); await expect(mode).toContainText('Plan'); await page.keyboard.press('Escape');
  await expect(chat.getByRole('combobox', { name: 'Model and reasoning', exact: true })).toBeEnabled();
  assert.equal(service.sessions.get(session.id).graphical, runtime); assert.equal(transport.calls.some(call => call.method === 'thread/resume'), false);
  child.notify('turn/started', { threadId: runtime.threadId, turn: { id: 'questions-turn', status: 'inProgress' } });
  child.request(905, 'item/tool/requestUserInput', { threadId: runtime.threadId, turnId: 'questions-turn', questions: [{ id: 'title', question: 'Preferred title?' }, { id: 'color', question: 'Color?', options: [{ label: 'Blue', description: 'Cool tone' }, { label: 'Red', description: 'Warm tone' }] }] });
  const request = chat.getByRole('region', { name: 'Agent request', exact: true }); await expect(request.getByRole('button', { name: 'Send answers', exact: true })).toBeDisabled();
  await request.getByRole('textbox', { name: 'Preferred title?', exact: true }).fill('My title'); await request.getByRole('combobox', { name: 'Color?', exact: true }).click(); await page.getByRole('option', { name: 'Blue · Cool tone', exact: true }).click();
  await request.getByRole('textbox', { name: 'Preferred title?', exact: true }).press('Enter'); await expect(request).toContainText('Response sent');
  const answer = transport.calls.find(call => call.id === 905 && call.result); assert.deepEqual(answer.result.answers, { title: { answers: ['My title'] }, color: { answers: ['Blue'] } });
  child.notify('serverRequest/resolved', { threadId: runtime.threadId, requestId: 905 }); child.notify('turn/completed', { threadId: runtime.threadId, turn: { id: 'questions-turn', status: 'completed' } });
  // Native Stop acknowledgement without its completion event: reconcile the
  // recorded final state and return the real composer to Send, without replay.
  const missed = { id: 'missed-stop-ui', status: 'inProgress' }, originalRpc = runtime.rpc.bind(runtime);
  child.interruptTurn = () => {};
  runtime.rpc = (method, params, timeout) => method === 'thread/read' ? Promise.resolve({ thread: { status: { type: 'idle' }, turns: [{ ...missed, status: 'interrupted' }] } }) : originalRpc(method, params, timeout);
  child.notify('turn/started', { threadId: runtime.threadId, turn: missed });
  await chat.getByRole('button', { name: 'Interrupt response', exact: true }).click();
  await expect.poll(() => runtime.snapshot().working).toBe(false);
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toHaveCount(0);
  await composer.fill('Ready after Stop');
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  assert.equal(transport.calls.filter(call => call.method === 'turn/steer').length, 1);
  await expect(request).toHaveCount(0); await page.screenshot({ path: path.join(root, '.cache/codex-chat-advanced.png') }); assert.deepEqual(errors, []);
  console.log('PASS: steer-only composer with no extra turn/queue, pending-request guard, legacy saved queue review, Context outside/Escape dismissal, exclusive detail popovers and narrow layout. No real model/login/UAC/user Hub.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
