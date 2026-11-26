// Production UI/service acceptance, synthetic Claude wire, no user Hub/accounts.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
let service, browser;
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-queue-ui-')), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  let wire;
  service.sessions.createGraphicalRuntime = options => { wire = claudeFixture(options.session.nativeId); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  const session = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Claude queue acceptance' });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = async (action, body) => {
    const result = await fetch(`${service.origin}/api/sessions/${session.id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) }); return result;
  };
  assert.ok((await post('focus', {})).ok);
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Claude graphical chat', exact: true }), input = chat.getByRole('textbox', { name: 'Message Claude', exact: true });
  const queue = chat.getByRole('region', { name: 'Queued messages', exact: true });
  await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toBeEnabled();
  await input.fill('first queued'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(queue).toContainText('first queued');
  await queue.getByRole('button', { name: 'Pause queue', exact: true }).click();
  await queue.getByRole('button', { name: 'Edit', exact: true }).click();
  await queue.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('edited queued');
  await queue.getByRole('button', { name: 'Save', exact: true }).click(); await expect(queue).toContainText('edited queued');
  await input.fill('remove this'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await queue.locator('li').filter({ hasText: 'remove this' }).getByRole('button', { name: 'Remove', exact: true }).click();
  assert.equal(wire.calls.filter(call => call.type === 'user').length, 1);
  await page.reload(); await expect(queue).toContainText('edited queued');
  await input.fill('keep my draft'); await expect.poll(() => service.sessions.get(session.id).graphical.draft).toBe('keep my draft');
  wire.transports.values().next().value.complete();
  await queue.getByRole('button', { name: 'Resume queue', exact: true }).click();
  assert.equal(wire.calls.filter(call => call.type === 'user').length, 1);
  await expect(input).toHaveValue('keep my draft'); await input.fill('');
  await expect(queue).toHaveCount(0);
  assert.equal(wire.calls.filter(call => call.type === 'user').length, 2);
  assert.equal(wire.calls.filter(call => call.type === 'user')[1].message.content[0].text, 'edited queued');
  const runtime = service.sessions.get(session.id).graphical;
  const stale = await post('chat', { action: 'enqueue', text: 'stale', requestId: crypto.randomUUID(), runtimeId: crypto.randomUUID() });
  assert.equal(stale.ok, false); assert.equal(runtime.pending.queue.length, 0);
  // Native question remains actionable only through its own scoped answer.
  await input.fill('question'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toBeVisible();
  await input.fill('after question'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(queue).toContainText('after question'); assert.equal(wire.calls.filter(call => call.type === 'control_response').length, 0);
  await chat.getByRole('button', { name: 'Interrupt response', exact: true }).click();
  await expect(queue.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: path.join(root, '.cache/claude-queue-ui.png') });
  await queue.getByRole('button', { name: 'Remove', exact: true }).click();
  // An accepted enqueue whose HTTP response was lost must retain its identity
  // across chat navigation and reload, just like accepted guidance.
  await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  let loseEnqueue = true;
  await page.route('**/api/sessions/*/chat', async route => {
    let body; try { body = route.request().postDataJSON(); } catch { /* GET */ }
    if (loseEnqueue && body?.action === 'enqueue') { loseEnqueue = false; await route.fetch(); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic lost enqueue response' }) }); }
    else await route.continue();
  });
  await input.fill('Enqueue exactly once across navigation'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(chat.getByRole('alert')).toContainText('Synthetic lost enqueue');
  const originalWire = wire;
  await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Queue navigation target' }); wire = originalWire;
  await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: 'Queue navigation target' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: session.name }).click();
  await page.reload(); await expect(input).toHaveValue('Enqueue exactly once across navigation');
  const queuedOnce = runtime.pending.queue.length, nativeCalls = wire.calls.filter(call => call.type === 'user').length;
  await chat.getByRole('button', { name: 'Queue message', exact: true }).click(); await expect(input).toHaveValue('');
  assert.equal(runtime.pending.queue.length, queuedOnce); assert.equal(queuedOnce, 1);
  assert.equal(wire.calls.filter(call => call.type === 'user').length, nativeCalls);
  assert.deepEqual(errors, []);
  console.log('PASS Claude production queue UI: enqueue while working/waiting, edit/remove/pause, reload, draft preservation, same-session ordered dispatch, stale runtime rejection, question isolation, narrow layout. No real model calls.');
} finally {
  await browser?.close(); await service?.close(); await cleanupFixtures();
}
