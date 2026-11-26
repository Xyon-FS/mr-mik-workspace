// Real keyboard input in a production build; synthetic providers/history only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-performance-'));
let service, browser;
const wires = [], measurements = [];
try {
  const uiDir = path.join(base, 'ui'), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: uiDir, emptyOutDir: false }, plugins: [{ name: 'chat-performance-counters', enforce: 'pre', transform(code, id) {
    const marker = id.endsWith('/GraphicalTimeline.tsx') ? '  const groups = useMemo' : id.endsWith('/ChatMarkdown.tsx') ? '  const components = useMemo' : null;
    if (!marker) return;
    const key = id.endsWith('/ChatMarkdown.tsx') ? 'markdown' : 'timeline';
    return code.replace(marker, `  if (globalThis.__chatPerformance) globalThis.__chatPerformance.${key}++;\n${marker}`);
  } }] });
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Performance fixture'), codex = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 480, height: 1000 } }), cdp = await page.context().newCDPSession(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__chatPerformance = { timeline: 0, markdown: 0, frames: [] };
    document.addEventListener('input', event => { if (event.target instanceof HTMLTextAreaElement) { const start = performance.now(); requestAnimationFrame(() => window.__chatPerformance.frames.push(performance.now() - start)); } }, true);
  });
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} long conversation`, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    const all = Array.from({ length: 5000 }, (_, index) => ({ id: `message-${index}`, type: index % 2 ? 'agentMessage' : 'userMessage', text: index % 2 ? `## Response ${index}\n\nA synthetic paragraph with **important information**.\n\n1. First action\n2. Second action\n\n\`\`\`typescript\nconst index = ${index};\nconsole.log(index);\n\`\`\`` : `Question ${index}`, details: '', turnId: `turn-${Math.floor(index / 2)}`, status: 'completed' }));
    const turns = Array.from({ length: 2500 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', startedAt: null, completedAt: null, durationMs: null, timingSource: 'unavailable' }));
    if (agent === 'codex') { runtime.items = new Map(all.slice(-100).map(item => [item.id, item])); runtime.turns = new Map(turns.slice(-50).map(turn => [turn.id, turn])); runtime.truncated = true; }
    else { Object.assign(runtime.protocol.state, { items: all.slice(-100), turns: turns.slice(-50), status: 'ready' }); runtime.hasOlder = true; }
    let calls = 0, inFlight = 0, maximumInFlight = 0, savedAnchor = null;
    runtime.older = async ({ beforeId }) => {
      calls++; maximumInFlight = Math.max(maximumInFlight, ++inFlight);
      try {
        savedAnchor = await page.locator('.graphical-messages').evaluate(element => {
          const top = element.getBoundingClientRect().top;
          const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.getBoundingClientRect().bottom > top + 5);
          return row ? { id: row.dataset.chatItem, top: row.getBoundingClientRect().top - top } : null;
        });
        await new Promise(resolve => setTimeout(resolve, 40));
        const end = all.findIndex(item => item.id === beforeId); assert.ok(end >= 0);
        const start = Math.max(0, end - 450), items = all.slice(start, end), ids = new Set(items.map(item => item.turnId));
        for (const item of items) (agent === 'codex' ? runtime.historyItems : runtime.loadedHistory).set(item.id, item);
        return { items, turns: turns.filter(turn => ids.has(turn.id)), hasOlder: start > 0, nextCursor: start > 0 ? `before-${start}` : null };
      } finally { inFlight--; }
    };
    runtime.changed();
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const name = agent === 'codex' ? 'Codex' : 'Claude', chat = page.getByRole('region', { name: `${name} graphical chat`, exact: true }), view = chat.locator('.graphical-messages'), input = chat.getByRole('textbox', { name: `Message ${name}`, exact: true });
    await expect(chat.locator('[data-chat-item="message-4999"]')).toBeVisible();
    let measured1000 = false;
    while (await chat.locator('.graphical-windowed').getAttribute('data-logical-turns') !== '2500') {
      const previous = calls, bounds = await view.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(0, -1000000);
      await expect.poll(() => calls, { message: `${agent}: scrolling up must load older messages` }).toBe(previous + 1);
      await expect.poll(() => inFlight).toBe(0);
      await expect.poll(async () => Number(await chat.locator('.graphical-windowed').getAttribute('data-logical-turns'))).toBeGreaterThan(50 + (calls - 1) * 225);
      if (savedAnchor) await expect.poll(() => view.evaluate((element, saved) => {
        const row = [...element.querySelectorAll('[data-chat-item]')].find(row => row.dataset.chatItem === saved.id);
        return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top) : 100000;
      }, savedAnchor), { message: `${agent}: prepend must preserve the visible message and pixel offset` }).toBeLessThan(4);
      assert.ok(await chat.locator('.graphical-message').count() < 80, 'Mounted messages must stay bounded');
      const logical = Number(await chat.locator('.graphical-windowed').getAttribute('data-logical-turns')) * 2;
      if (logical === 1000 && !measured1000 || logical === 5000) {
        measured1000 = true;
        await chat.getByRole('button', { name: /^Back to latest/ }).click();
        await expect(chat.locator('[data-chat-item="message-4999"]')).toBeVisible();
        await input.fill('Warm draft'); await page.waitForTimeout(500);
        for (const rate of [1, 4]) {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          await page.evaluate(() => { window.__chatPerformance = { timeline: 0, markdown: 0, frames: [] }; });
          await input.press('End'); await page.keyboard.type(' twenty typed letters');
          await expect(input).toHaveValue(rate === 1 ? 'Warm draft twenty typed letters' : 'Warm draft twenty typed letters twenty typed letters');
          await page.waitForTimeout(100);
          const sample = await page.evaluate(() => window.__chatPerformance);
          assert.ok(sample.timeline <= 3, `${agent}: typing must not render the timeline per character: ${JSON.stringify(sample)}`);
          assert.ok(sample.markdown < 200, `${agent}: completed history must not render per character`);
          const sorted = sample.frames.sort((a, b) => a - b);
          measurements.push({ agent, logicalItems: logical, cpuSlowdown: rate, timelineRenders: sample.timeline, markdownRenders: sample.markdown, frameP95Ms: Math.round(sorted[Math.floor(sorted.length * .95)] || 0), mountedMessages: await chat.locator('.graphical-message').count() });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        }
      }
      if (calls > 12) throw new Error('Unexpected history request loop');
    }
    await expect(chat.getByRole('button', { name: 'Expand code', exact: true })).toHaveCount(0);
    const previewResponse = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}/previewblock`));
    await chat.getByRole('button', { name: 'Open code in Workspace', exact: true }).last().click(); assert.ok((await previewResponse).ok());
    // Rich-block interaction deliberately pauses following; explicitly return to latest before testing incoming-tail following.
    const resumeLatest=chat.getByRole('button',{name:/^Back to latest/});await expect(resumeLatest).toBeVisible();await resumeLatest.click();await expect(resumeLatest).toHaveCount(0);await expect.poll(()=>view.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(3);await page.waitForTimeout(250);
    const background = Array.from({ length: 20 }, (_, i) => ({ id: `preview-${i}`, turnId: `preview-${i}`, type: 'agentMessage', text: `Background result ${i}`, status: 'completed', details: '' }));
    if (agent === 'codex') runtime.items = new Map([...runtime.items.values(), ...background].slice(-150).map(item => [item.id, item]));
    else runtime.protocol.state.items = [...runtime.protocol.state.items, ...background].slice(-150);
    runtime.changed(); await expect(chat.getByText('Background result 19', { exact: true })).toBeVisible();
    const last = agent === 'codex' ? [...runtime.items.values()].at(-1) : runtime.protocol.state.items.at(-1), originalText = last.text;
    if (agent === 'codex') runtime.turnId = last.turnId;
    else Object.assign(runtime.protocol.state, { status: 'running' });
    last.status = agent === 'codex' ? 'inProgress' : 'running'; runtime.changed();
    await input.fill('Streaming draft'); await page.waitForTimeout(400);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => { window.__chatPerformance = { timeline: 0, markdown: 0, frames: [] }; });
    const stream = setInterval(() => { last.text += ' chunk'; runtime.changed(); }, 20);
    try { await input.press('End'); await page.keyboard.type(' while output arrives', { delay: 10 }); } finally { clearInterval(stream); }
    await expect(input).toHaveValue('Streaming draft while output arrives');
    const streaming = await page.evaluate(() => window.__chatPerformance);
    assert.ok(streaming.markdown < 800, 'Streaming must not render thousands of completed messages per update');
    measurements.push({ agent, logicalItems: 5000, cpuSlowdown: 4, streaming: true, timelineRenders: streaming.timeline, markdownRenders: streaming.markdown, mountedMessages: await chat.locator('.graphical-message').count() });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    last.text = originalText; last.status = 'completed';
    if (agent === 'codex') runtime.turnId = null; else runtime.protocol.state.status = 'ready'; runtime.changed();
    await expect(input).toHaveAttribute('placeholder', `Ask ${name} to do anything…`);
    await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await input.fill('Complete current draft after a long conversation');
    await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
    if (agent === 'codex') assert.equal(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, 'Complete current draft after a long conversation');
    else assert.equal(wires.at(-1).calls.filter(call => call.type === 'user').at(-1).message.content[0].text, 'Complete current draft after a long conversation');
    assert.equal(maximumInFlight, 1);
    await page.waitForTimeout(100);
    let retainedTurns = Number(await chat.locator('.graphical-windowed').getAttribute('data-logical-turns'));
    for (let batch = 0; batch < 4; batch++) {
      const arriving = Array.from({ length: 50 }, (_, index) => ({ id: `follow-${batch}-${index}`, turnId: `follow-${batch}-${index}`, type: 'agentMessage', text: `Later result ${batch}/${index}`, status: 'completed', details: '' }));
      if (agent === 'codex') runtime.items = new Map([...runtime.items.values(), ...arriving].slice(-150).map(item => [item.id, item]));
      else runtime.protocol.state.items = [...runtime.protocol.state.items, ...arriving].slice(-150);
      runtime.changed(); retainedTurns += 50;
      await expect(chat.locator('.graphical-windowed')).toHaveAttribute('data-logical-turns', String(retainedTurns));
      await expect(chat.getByText(`Later result ${batch}/49`, { exact: true })).toBeVisible();
      await page.waitForTimeout(80);
    }
    // A hidden/throttled view can miss more than a live tail. Never join two
    // disjoint windows and silently present the gap as continuous history.
    await page.waitForTimeout(100);
    const newest = { id: 'after-missed-tail', type: 'agentMessage', text: 'Recovered latest window', status: 'completed', turnId: 'recovered', details: '' };
    if (agent === 'codex') { runtime.items = new Map([[newest.id, newest]]); runtime.turnId = null; }
    else Object.assign(runtime.protocol.state, { items: [newest], status: 'ready' });
    runtime.changed(); await expect(chat.getByText('Recovered latest window', { exact: true })).toBeVisible();
    await expect(chat.locator('.graphical-windowed')).toHaveCount(0);
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, '.cache/chat-performance-results.json'), JSON.stringify({ synthetic: true, timing: 'Input-event to next rAF proxy; CPU slowdown artificial', measurements }, null, 2));
  console.log('PASS 1000/5000-item Codex/Claude conversations: automatic upward paging, retained latest, bounded mounted messages, isolated real keyboard typing at normal/4x CPU, fresh complete draft delivery, one history request in flight. Synthetic providers only.');
} finally { await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
