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
let service, browser, releaseReply;
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-steer-ui-')), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  let wire;
  service.sessions.createGraphicalRuntime = options => { wire = claudeFixture(options.session.nativeId, { holdSteerResult: true }); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  const session = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Claude steering acceptance' });
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
  const runtime = service.sessions.get(session.id).graphical, target = runtime.snapshot().activeTurnId;
  const sent = () => wire.calls.filter(call => call.type === 'user');
  await input.fill('queued after steer'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(queue).toContainText('queued after steer');
  await input.fill('Guide the current activity');
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toHaveAttribute('title', 'Send guidance now');
  await input.press('Enter'); await expect(input).toHaveValue('');
  await expect.poll(() => sent().filter(call => call.priority === 'now').length).toBe(1);
  const first = sent().find(call => call.priority === 'now').uuid;
  wire.transports.values().next().value.emit({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming', user_message_uuids: [sent()[0].uuid] });
  assert.equal(runtime.snapshot().status, 'running'); assert.equal(runtime.snapshot().turns.length, 1);
  assert.equal(sent().length, 2); await expect(queue).toContainText('queued after steer');
  await input.fill('A second correction'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue(''); await expect.poll(() => sent().filter(call => call.priority === 'now').length).toBe(2);
  const second = sent().filter(call => call.priority === 'now')[1].uuid;
  wire.transports.values().next().value.emit({ type: 'result', subtype: 'success', user_message_uuids: [first], result: 'Older native segment' });
  assert.equal(runtime.snapshot().status, 'running'); assert.equal(sent().length, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: path.join(root, '.cache/claude-steer-ui.png') });
  const stale = await post('chat', { action: 'steer', text: 'stale', requestId: crypto.randomUUID(), expectedTurnId: crypto.randomUUID(), runtimeId: runtime.runtimeId });
  assert.equal(stale.ok, false); assert.equal(sent().length, 3);
  wire.transports.values().next().value.emit({ type: 'result', subtype: 'success', user_message_uuids: [second], result: 'Final guided answer' });
  await expect(queue).toHaveCount(0); await expect.poll(() => sent().length).toBe(4);
  assert.equal(runtime.snapshot().turns[0].id, target); assert.equal(runtime.snapshot().turns.length, 2);
  assert.equal(sent()[3].message.content[0].text, 'queued after steer');
  // Lose the HTTP response after the native process accepted guidance. A retry
  // after the turn finishes must reuse the old receipt, never become direct send.
  await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  let lose = true;
  await page.route('**/api/sessions/*/chat', async route => {
    let body; try { body = route.request().postDataJSON(); } catch { /* GET snapshot */ }
    if (lose && body?.action === 'steer') { lose = false; await route.fetch(); await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic lost response after native acceptance' }) }); }
    else await route.continue();
  });
  await input.fill('Retry this exact receipt'); await input.press('Enter');
  await expect(chat.getByRole('alert')).toContainText('Synthetic lost response');
  await expect(input).toHaveValue('Retry this exact receipt');
  const lost = sent().at(-1).uuid, count = sent().length;
  wire.transports.values().next().value.emit({ type: 'result', subtype: 'success', user_message_uuids: [lost], result: 'Receipt completed despite response loss' });
  await expect.poll(() => runtime.snapshot().working).toBe(false);
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).not.toHaveAttribute('title', 'Send guidance now');
  const originalWire = wire;
  await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Guidance navigation target' }); wire = originalWire;
  await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: 'Guidance navigation target' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: session.name }).click();
  await page.reload(); await expect(input).toHaveValue('Retry this exact receipt');
  await input.press('Enter'); await expect(input).toHaveValue(''); assert.equal(sent().length, count);
  // A successful response may also arrive while its view is unmounted. The
  // shared draft is consumed there, but a newer edit in a remounted view wins.
  for (const newerEdit of [false, true]) {
    await page.unrouteAll(); await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    let arrived; const accepted = new Promise(resolve => { arrived = resolve; });
    const responseGate = new Promise(resolve => { releaseReply = resolve; }); let hold = true;
    await page.route('**/api/sessions/*/chat', async route => {
      let body; try { body = route.request().postDataJSON(); } catch { /* GET */ }
      if (hold && body?.action === 'steer') { hold = false; const response = await route.fetch(); arrived(); await responseGate; await route.fulfill({ response }); }
      else await route.continue();
    });
    await input.fill('Accepted while its view is away'); await input.press('Enter'); await accepted;
    const acceptedId = sent().at(-1).uuid, acceptedCount = sent().length;
    await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
    await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: 'Guidance navigation target' }).click();
    await expect(input).toHaveValue('');
    wire.transports.values().next().value.emit({ type: 'result', subtype: 'success', user_message_uuids: [acceptedId], result: 'Guidance done while away' });
    if (newerEdit) {
      await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
      await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: session.name }).click();
      await page.waitForTimeout(450);
      assert.equal(runtime.draft, '', 'accepted guidance draft must not be written back while its HTTP response is pending');
      await input.fill('Preserve newer text in remounted view');
    }
    releaseReply();
    await expect.poll(() => page.evaluate(id => localStorage.getItem('mrmak.claude-pending-action.' + id), session.id)).toBe(null);
    if (!newerEdit) {
      await page.getByRole('button', { name: 'Find a chat', exact: true }).click();
      await page.getByRole('dialog', { name: 'Find a chat', exact: true }).getByRole('button').filter({ hasText: session.name }).click();
    }
    await expect(input).toHaveValue(newerEdit ? 'Preserve newer text in remounted view' : '');
    await page.reload(); await expect(input).toHaveValue(newerEdit ? 'Preserve newer text in remounted view' : '');
    assert.equal(sent().length, acceptedCount);
  }
  // A definite pre-wire rejection is different from the lost response above:
  // the next explicit Enter may send the preserved draft to the now-idle turn.
  await page.unrouteAll(); await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  let completeBeforeGuidance = true;
  await page.route('**/api/sessions/*/chat', async route => {
    let body; try { body = route.request().postDataJSON(); } catch { /* GET snapshot */ }
    if (completeBeforeGuidance && body?.action === 'steer') { completeBeforeGuidance = false; wire.transports.values().next().value.complete('Completed before guidance arrived'); }
    await route.continue();
  });
  await input.fill('Retry a definitely unsent correction'); await input.press('Enter');
  await expect(chat.getByRole('alert')).toContainText('active Claude turn changed');
  const beforeRetry = sent().length;
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).not.toHaveAttribute('title', 'Send guidance now');
  await input.press('Enter'); await expect(input).toHaveValue('');
  await expect.poll(() => sent().length).toBe(beforeRetry + 1);
  assert.deepEqual(errors, []);
  console.log('PASS Claude production UI steering: Enter/primary button guide now, explicit Queue remains separate, repeated corrections stay in one logical activity, intermediate native results do not drain work, stale turns rejected, narrow layout. No real model calls.');

} finally {
  releaseReply?.(); await browser?.close(); await service?.close(); await cleanupFixtures();
}
