// Actual browser scrolling against the production UI, synthetic runtimes only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-scroll-followup-'));
const portableIndex = process.argv.indexOf('--portable');
const portable = portableIndex < 0 ? null : path.resolve(process.argv[portableIndex + 1]);
const uiIndex = process.argv.indexOf('--ui');
const evidenceIndex = process.argv.indexOf('--evidence');
const evidenceFile = evidenceIndex < 0 ? path.join(root, '.cache/chat-scrolling-evidence.json') : path.resolve(process.argv[evidenceIndex + 1]);
const serviceRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(serviceRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
let service, browser;
const wires = [], evidence = [], historyWaiters = [];
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : uiIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[uiIndex + 1]), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Scroll fixture'), transport = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: transport.spawnChild });
    const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 480, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const observer = new MutationObserver(records => {
      const rows = records.flatMap(record => [...record.addedNodes].flatMap(node => node instanceof Element
        ? node.matches('.graphical-virtual-turn') ? [node] : [...node.querySelectorAll('.graphical-virtual-turn')]
        : []));
      if (!rows.length) return;
      window.initialVirtualRows = rows.map(row => Number(row.getAttribute('data-index')));
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} scrolling`, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    const all = Array.from({ length: 600 }, (_, index) => ({ id: `row-${index}`, turnId: `turn-${Math.floor(index / 2)}`, type: index % 2 ? 'agentMessage' : 'userMessage', text: index % 2 ? `Response ${index}\n\n${'A synthetic paragraph for scrolling. '.repeat(12)}\n\n\`\`\`js\nconst value = 42;\n\`\`\`` : `Question ${index}`, status: 'completed', details: '' }));
    const turns = Array.from({ length: 300 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', startedAt: null, completedAt: null, durationMs: null, timingSource: 'unavailable' }));
    const setTail = (hasOlder = true, count = 50) => {
      const items = all.slice(-2 * count), tail = turns.slice(-count);
      if (agent === 'codex') { runtime.items = new Map(items.map(item => [item.id, item])); runtime.turns = new Map(tail.map(turn => [turn.id, turn])); runtime.truncated = hasOlder; }
      else { Object.assign(runtime.protocol.state, { items, turns: tail, status: 'ready' }); runtime.hasOlder = hasOlder; }
      runtime.changed();
    };
    setTail();
    let historyCalls = 0, releaseHistory;
    runtime.older = async ({ beforeId }) => {
      historyCalls++;
      if (releaseHistory !== false) await new Promise(resolve => { releaseHistory = resolve; historyWaiters.push(resolve); });
      const end = all.findIndex(item => item.id === beforeId), start = Math.max(0, end - 100);
      return { items: all.slice(start, end), turns, nextCursor: start ? `before-${start}` : null, hasOlder: start > 0 };
    };
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), view = chat.locator('.graphical-messages');
    await expect(chat).toBeVisible();
    if(await page.getByRole('complementary',{name:'Conversations by project'}).isVisible())await page.getByRole('button',{name:'Collapse project panel',exact:true}).click();
    const bottom = () => view.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect(chat.locator('[data-chat-item="row-599"]')).toBeVisible(); await expect.poll(bottom).toBeLessThan(3);
    const initialRows = await page.evaluate(() => window.initialVirtualRows);
    assert.ok(initialRows?.includes(49) && initialRows.every(index => index >= 45), `${agent}: the first virtual rows should be recent, received ${initialRows}`);
    const bounds = await view.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const start = await view.evaluate(element => element.scrollTop);
    // Browser-generated animation emits many scroll events for one intent,
    // reproducing the ownership problem seen with momentum/keyboard scrolling.
    await view.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -700 })); element.scrollBy({ top: -700, behavior: 'smooth' }); });
    await page.waitForTimeout(700);
    const end = await view.evaluate(element => element.scrollTop);
    evidence.push({ agent, scenario: 'animated-upward-gesture', start, end, travelled: start - end });
    await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
    assert.ok(start - end > 600, `${agent}: scroll was pulled back during the gesture (${Math.round(start - end)}px of 700px)`);
    const latest = chat.getByRole('button', { name: /^Back to latest/ }); await expect(latest).toBeVisible(); await latest.click();
    await expect.poll(bottom).toBeLessThan(3); await expect(latest).toHaveCount(0);
    for (let index = 0; index < 5; index++) { await page.mouse.wheel(0, -180); await page.waitForTimeout(50); }
    await expect(latest).toBeVisible();
    const frozen = await view.evaluate(element => { const top = element.getBoundingClientRect().top; const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.getBoundingClientRect().bottom > top + 5); return { id: row.dataset.chatItem, top: row.getBoundingClientRect().top - top }; });
    all.push({ id: 'arrival', turnId: 'arrival', type: 'agentMessage', text: 'New result while reading earlier messages.', status: 'completed', details: '' }); setTail();
    await expect.poll(() => view.evaluate((element, saved) => { const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.dataset.chatItem === saved.id); return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top) : 100000; }, frozen)).toBeLessThan(4);
    await latest.click(); await expect(chat.getByText('New result while reading earlier messages.', { exact: true })).toBeVisible(); await expect.poll(bottom).toBeLessThan(3);
    setTail(true); await expect(chat).toHaveAttribute('data-chat-revision', String(runtime.revision));
    await page.mouse.wheel(0, -1000000); await expect.poll(() => historyCalls).toBe(1);
    await latest.click(); releaseHistory(); releaseHistory = false;
    await expect(chat.getByRole('button', { name: 'Loading history…', exact: true })).toHaveCount(0);
    await expect.poll(bottom).toBeLessThan(3); await expect(latest).toHaveCount(0);
    await page.waitForTimeout(350); assert.ok(await bottom() < 3, 'Stale history/animation work must not reverse latest');
    await view.evaluate(element => { element.tabIndex = -1; element.focus(); });
    const keyboardStart = await view.evaluate(element => element.scrollTop);
    await page.keyboard.press('PageUp'); await page.waitForTimeout(500);
    assert.ok(keyboardStart - await view.evaluate(element => element.scrollTop) > 100, `${agent}: PageUp must release following`);
    await latest.click(); await expect.poll(bottom).toBeLessThan(3);
    releaseHistory = undefined;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -1000000); await expect.poll(() => historyCalls).toBe(2);
    await page.waitForTimeout(250);
    const beforePrepend = await view.evaluate(element => { const top = element.getBoundingClientRect().top; const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.getBoundingClientRect().bottom > top + 5); return { id: row.dataset.chatItem, top: row.getBoundingClientRect().top - top }; });
    releaseHistory(); releaseHistory = false;
    await expect(chat.getByRole('button', { name: 'Loading history…', exact: true })).toHaveCount(0);
    await expect.poll(() => view.evaluate((element, saved) => { const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.dataset.chatItem === saved.id); return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top) : 100000; }, beforePrepend)).toBeLessThan(4);
    await latest.click(); await expect.poll(bottom).toBeLessThan(3);
    await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(bottom).toBeLessThan(3);
    await page.setViewportSize({ width: 480, height: 1000 });

    all.pop();
    setTail(true, 15);
    await page.reload();
    await expect(chat.locator('[data-chat-item="row-599"]')).toBeInViewport();
    await expect.poll(bottom).toBeLessThan(3);
    await expect(view.locator('.graphical-windowed')).toHaveCount(0);
    const beforeVirtualizing = await view.evaluate(element => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.getBoundingClientRect().bottom > top + 5);
      return { id: row.dataset.chatItem, top: row.getBoundingClientRect().top - top };
    });
    // Keep the reading position while invoking the button at the start of the transcript.
    await chat.getByRole('button', { name: 'Load older messages', exact: true }).evaluate(button => button.click());
    await expect(view.locator('.graphical-windowed')).toHaveAttribute('data-logical-turns', '65');
    await expect.poll(() => view.evaluate((element, { id, top }) => {
      const row = element.querySelector(`[data-chat-item="${id}"]`);
      return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - top) : Infinity;
    }, beforeVirtualizing)).toBeLessThan(4);
  }
  assert.deepEqual(errors, []); assert.equal(transport.calls.some(call => call.method === 'turn/start'), false); assert.equal(wires.flatMap(wire => wire.calls).some(call => call.type === 'user'), false);
  console.log('PASS Codex/Claude scroll ownership: animated gestures, keyboard navigation, background arrivals, anchored older-page prepends across the virtualization threshold, explicit latest, stale history cancellation and narrow resize. Zero model prompts.');
} finally { for (const release of historyWaiters) release(); await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
