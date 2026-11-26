// Isolated normal-terminal regression; never starts an agent or modifies a user Hub.
import assert from 'node:assert/strict';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { mkdtemp, createService, testBrowserEnvironment } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-completion-scroll-test-'));
const repo = path.join(base, 'hub'), uiDir = path.join(base, 'ui');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await cp(path.join(root, 'dist'), uiDir, { recursive: true });
const service = await createService({ repo, uiDir, mcpOptions: { home: path.join(base, 'home'), env: {} } });
const chat = service.sessions.make({ id: 'scroll-fixture', agent: 'codex', cwd: repo, name: 'Scroll fixture', open: true, status: 'running', activity: 'working', cols: 90, rows: 30 });
await service.sessions.hydrate(chat); service.sessions.items.set(chat.id, chat);
chat.launchedCodexPermissions = chat.codexPermissions;
chat.process = { write() {}, resize() {}, kill() {} };
await new Promise(resolve => chat.terminal.write(Array.from({ length: 400 }, (_, n) => `Fixture line ${n}\r\n`).join('') + '\x1b[?1000h\x1b[?1006h', resolve));
let browser;
try {
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  let snapshots = 0;
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => { if (String(payload).includes('"type":"snapshot"')) snapshots++; }));
  await page.goto(service.urls.chats, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('.xterm-screen'); await screen.waitFor();
  await page.locator('.xterm-rows').filter({ hasText: 'Fixture line' }).waitFor();
  await page.waitForTimeout(300);
  const bottomText = await page.locator('.xterm-rows').innerText();
  await screen.hover(); await page.mouse.wheel(0, -420);
  await page.waitForFunction(previous => document.querySelector('.xterm-rows')?.innerText !== previous, bottomText);
  await page.waitForTimeout(200);
  // xterm 6 manages scroll in a ScrollableElement; legacy viewport scrollTop
  // is not a reading coordinate. Compare the visible passage instead.
  const view = () => page.evaluate(() => ({ text: document.querySelector('.xterm-rows').textContent }));
  const before = await view(); const snapshotCount = snapshots;
  const firstLine = Number(/Fixture line (\d+)/.exec(before.text)?.[1]);
  assert.ok(firstLine > 0 && firstLine < 362, `Fixture must browse history away from both edges: ${firstLine}`);
  service.sessions.nativeEvent(chat, { kind: 'turn-completed', id: 'fixture-completion', preview: 'Done.' });
  await page.waitForTimeout(250);
  const completed = await view();
  assert.equal(completed.text, before.text, 'Completion metadata changed browsed history');
  assert.equal(snapshots, snapshotCount, 'Completion resubscribed/reset the terminal');
  const output = '\r\nWorked for 1s\r\nAsk Codex to do anything';
  await new Promise(resolve => chat.terminal.write(output, resolve));
  chat.pendingOutput += output; service.sessions.flushOutput(chat);
  await page.waitForTimeout(200);
  assert.equal((await view()).text, before.text, 'Ordinary completion output moved browsed lines');
  console.log('PASS: completion state and ordinary final output preserve scrolled-up history; no snapshot/remount.');
  for (let n = 0; n < 70; n++) {
    const fragment = `\r\nStreaming fixture segment ${n}`;
    await new Promise(resolve => chat.terminal.write(fragment, resolve));
    chat.pendingOutput += fragment; service.sessions.flushOutput(chat);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(200);
  assert.equal((await view()).text, before.text, 'Streaming must preserve the browsed historical rows');
  await screen.hover(); await page.mouse.wheel(0, 100000); await page.waitForTimeout(250);
  assert.match((await view()).text, /Streaming fixture segment 69/, 'Output must remain available before completion');
  console.log('PASS: streamed output remains available while browsing history.');
  // Reproduce the user's native history replacement, across output chunks.
  await screen.hover(); await page.mouse.wheel(0, -420); await page.waitForTimeout(150);
  const reading = await view();
  const anchorLine = /Fixture line (\d+)/.exec(reading.text)?.[1];
  // The current live screen contains streamed lines; browse far enough into
  // the original history to get an unambiguous anchor.
  if (!anchorLine) { await page.mouse.wheel(0, -1200); await page.waitForTimeout(150); }
  const anchored = await view();
  const anchoredLine = /Fixture line (\d+)/.exec(anchored.text)?.[1];
  assert.ok(anchoredLine, 'Reading anchor must be inside the original history');
  chat.pendingOutput += '\x1b[H\x1b[2J\x1b[3J\x1b[H\x1b[2J\x1b[3J'; service.sessions.flushOutput(chat);
  await page.waitForTimeout(150);
  const rebuilt = Array.from({ length: 40 }, (_, n) => `Inserted history ${n}\r\n`).join('') + Array.from({ length: 400 }, (_, n) => `Fixture line ${n}\r\n`).join('');
  chat.pendingOutput += rebuilt; service.sessions.flushOutput(chat);
  await page.waitForFunction(line => document.querySelector('.xterm-rows')?.textContent?.startsWith(`Fixture line ${line}`), anchoredLine);
  assert.equal(snapshots, snapshotCount, 'Native redraw restoration must not resubscribe');
  console.log('PASS: double native erase and chunked redraw restore the same reading line after 40 inserted rows.');
  assert.equal(await page.locator('text=Start scroll diagnosis · temporary').count(), 0);
} finally {
  await browser?.close(); chat.process = null; await service.close();
  await rm(base, { recursive: true, force: true });
}
