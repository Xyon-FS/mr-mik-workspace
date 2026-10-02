// Isolated ticking PTY fixture: no native agent/model request or personal Hub.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-terminal-live-test-'));
const repo = path.join(base, 'hub'), uiDir = path.join(base, 'ui');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await cp(path.join(root, 'dist'), uiDir, { recursive: true });
const service = await createService({ repo, uiDir, mcpOptions: { home: path.join(base, 'home'), env: {} } });
const chat = service.sessions.make({ id: 'tick-fixture', agent: 'codex', cwd: repo, name: 'Tick fixture', open: true, status: 'running', activity: 'working', createdAt: new Date().toISOString(), cols: 90, rows: 30 });
await service.sessions.hydrate(chat); service.sessions.items.set(chat.id, chat);
let focused = false, ticks = 0, browser;
const writes = [];
chat.process = { write(data) { writes.push(data); if (data === '\x1b[I') focused = true; if (data === '\x1b[O') focused = false; }, resize() {}, kill() {} };
await new Promise(resolve => chat.terminal.write('\x1b[?1004hWorking (0s · esc to interrupt)', resolve));
const timer = setInterval(() => {
  if (!focused) return;
  const data = `\r\x1b[2KWorking (${++ticks}s · esc to interrupt)`;
  chat.terminal.write(data); chat.pendingOutput += data; service.sessions.flushOutput(chat);
}, 200);
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage();
  await page.goto(service.urls.chats);
  await page.locator('.xterm-helper-textarea').focus();
  await page.waitForFunction(() => /Working \([1-9]\d*s/.test(document.querySelector('.xterm-rows')?.textContent || ''));
  const first = ticks;
  await page.waitForFunction(first => Number(/Working \((\d+)s/.exec(document.querySelector('.xterm-rows')?.textContent || '')?.[1]) > first, first);
  assert.ok(writes.includes('\x1b[I'), 'Native focus event was dropped');
  assert.equal(chat.lastInputAt, undefined, 'Focus notifications must not become typing');
  await page.getByTitle('Chat options', { exact: true }).focus();
  await page.waitForTimeout(150);
  assert.ok(writes.includes('\x1b[O'), 'Native blur event was dropped');
  await page.locator('.xterm-helper-textarea').focus();
  const next = ticks;
  await page.waitForFunction(next => Number(/Working \((\d+)s/.exec(document.querySelector('.xterm-rows')?.textContent || '')?.[1]) > next, next);
  console.log('PASS: focus/blur reaches CLI; Working ticks render without new chat messages; protocol events do not count as typing.');
} finally { clearInterval(timer); await browser?.close(); chat.process = null; await service.close(); await rm(base, { recursive: true, force: true }); }
