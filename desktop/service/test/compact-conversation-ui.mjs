// Isolated fake terminal and synthetic text; no live agent or user transcript.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repo = await mkdtemp(path.join(os.tmpdir(), 'mik-compact-ui-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir: path.join(root, 'dist'), restoreSessions: false, mcpOptions: { home: path.join(repo, 'home'), env: {} } });
let browser;
try {
  const chat = service.sessions.make({ id: 'compact-fixture', name: 'Compact fixture', agent: 'codex', cwd: repo, status: 'running', open: true, activity: 'idle', cols: 90, rows: 30, createdAt: new Date().toISOString() });
  await service.sessions.hydrate(chat); service.sessions.items.set(chat.id, chat);
  chat.launchedCodexPermissions = chat.codexPermissions;
  const writes = [];
  chat.process = { write: value => writes.push(value), resize() {}, kill() {} };
  await new Promise(resolve => chat.terminal.write('Native terminal retained\r\nRan fixture operation\r\n› Ask Codex to do anything', resolve));
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 650, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const messages = [{ id: 'one', role: 'user', text: 'Please update the card.\n\n`neutral_code`' }, { id: 'two', role: 'assistant', text: 'The card is updated.\n\n| Component | Responsibility | Example |\n| --- | --- | --- |\n| Model | State and rules of the game | Health, damage and cooldown intervals |\n| View | Representation and connections to Unity objects | Sprite, Transform and visibility |\n\n```text\n  keep    spacing\n```' }];
  await page.route('**/api/sessions/*/conversation', route => route.fulfill({ json: { status: 'ready', truncated: false, messages } }));
  await page.goto(service.urls.chats, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Hide operations', exact: true }).click();
  await page.getByText('The card is updated.', { exact: true }).waitFor();
  assert.equal(await page.locator('.terminal-host').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Send typed CLI prompt', exact: true }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: /Write \/ native prompts/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Show operations', exact: true }).evaluate(el => el.previousElementSibling?.getAttribute('aria-label')), 'Attach files');
  const colors = () => page.evaluate(() => ({
    user: getComputedStyle(document.querySelector('.compact-message.user p')).color,
    assistant: getComputedStyle(document.querySelector('.compact-message.assistant p')).color,
    code: getComputedStyle(document.querySelector('.compact-message.user code')).color,
    table: getComputedStyle(document.querySelector('.compact-table-scroll table')).color,
  }));
  await page.evaluate(() => { document.documentElement.dataset.accentTheme = 'rose'; });
  const rose = await colors();
  assert.notEqual(rose.user, rose.assistant, 'User text must be subtly distinct');
  await page.evaluate(() => { document.documentElement.dataset.accentTheme = 'blue'; });
  const blue = await colors();
  assert.notEqual(blue.user, rose.user, 'User tint must follow the accent theme');
  assert.equal(blue.assistant, rose.assistant, 'Assistant text must stay neutral');
  assert.equal(blue.code, rose.code, 'Code must stay neutral');
  assert.equal(blue.table, rose.table, 'Tables must stay neutral');
  assert.equal(await page.locator('.compact-table-scroll tbody tr').count(), 2);
  assert.equal(await page.locator('.compact-table-scroll th').count(), 3);
  assert.equal(await page.locator('.compact-message pre code').textContent(), '  keep    spacing\n');
  assert.equal(await page.locator('.compact-message pre').evaluate(el => getComputedStyle(el).whiteSpace), 'pre');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.locator('.compact-table-scroll').evaluate(el => el.scrollWidth > el.clientWidth), 'Wide tables must scroll inside their own container');
  const table = page.locator('.compact-table-scroll');
  const left = await table.evaluate(el => { window.scrollTestTable = el; el.focus(); el.scrollLeft = 100; return el.scrollLeft; });
  assert.ok(left > 0);
  await page.waitForTimeout(2400);
  assert.deepEqual(await table.evaluate(el => ({ same: el === window.scrollTestTable, left: el.scrollLeft, focused: document.activeElement === el })), { same: true, left, focused: true }, 'Unchanged polling must retain table node, horizontal position and focus');
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Unsent scrolling regression draft');
  assert.deepEqual(await table.evaluate(el => ({ same: el === window.scrollTestTable, left: el.scrollLeft })), { same: true, left }, 'Composer updates must not remount tables');
  messages[1].text += '\n\nA newly saved paragraph.';
  await page.getByText('A newly saved paragraph.', { exact: true }).waitFor();
  assert.deepEqual(await table.evaluate(el => ({ same: el === window.scrollTestTable, left: el.scrollLeft })), { same: true, left }, 'Changed message content must retain the existing table');
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('');
  await page.setViewportSize({ width: 650, height: 800 });
  if (process.env.MRMIK_COMPACT_SCREENSHOT) await page.screenshot({ path: process.env.MRMIK_COMPACT_SCREENSHOT });
  const before = writes.length;
  await page.keyboard.type('must not enter hidden CLI');
  // Startup protocol/focus replies may arrive asynchronously; they are not typing.
  assert.equal(writes.slice(before).filter(value => !value.startsWith('\x1b')).join(''), '');
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Update the card\nKeep its sections');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.compact-composer textarea')?.value === '');
  await page.waitForTimeout(600);
  assert.ok(writes.includes('\x1b[200~Update the card\nKeep its sections\x1b[201~'));
  assert.ok(writes.includes('\r'));
  assert.equal(await page.locator('.compact-conversation').isVisible(), true, 'Sending must keep conversation view');
  await page.getByRole('button', { name: 'Show operations', exact: true }).click();
  assert.equal(await page.locator('.terminal-host').isVisible(), true);
  assert.match(await page.locator('.xterm-rows').innerText(), /Native terminal retained/);
  await page.getByRole('button', { name: 'Hide operations', exact: true }).click();
  for (let i = 0; i < 45; i++) messages.push({ id: `extra-${i}`, role: 'assistant', text: `Visible answer ${i}.` });
  await page.getByText('Visible answer 44.', { exact: true }).waitFor();
  await page.locator('.compact-messages').evaluate(el => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); });
  const scroll = await page.locator('.compact-messages').evaluate(el => el.scrollTop);
  messages.push({ id: 'new-answer', role: 'assistant', text: 'Another saved answer.' });
  await page.getByText('Another saved answer.', { exact: true }).waitFor();
  assert.equal(await page.locator('.compact-messages').evaluate(el => el.scrollTop), scroll, 'Polling must preserve browsing position');
  await page.getByRole('textbox', { name: 'Message Codex' }).fill('Retain this draft');
  chat.activity = 'waiting'; service.sessions.changed(chat);
  await page.waitForFunction(() => !document.querySelector('.compact-conversation'));
  assert.equal(await page.locator('.terminal-host').isVisible(), true);
  chat.activity = 'idle'; service.sessions.changed(chat);
  await page.getByRole('textbox', { name: 'Message Codex' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message Codex' }).inputValue(), 'Retain this draft');
  await new Promise(resolve => chat.terminal.write('\r\x1b[2K› Native draft', resolve));
  const sentBefore = writes.length;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'not empty or ready' }).waitFor();
  assert.equal(writes.length, sentBefore, 'A native draft/dialog must never receive compact input');
  assert.equal(await page.getByRole('textbox', { name: 'Message Codex' }).inputValue(), 'Retain this draft');
  assert.deepEqual(errors, []);
  console.log('Compact theme tint, Markdown tables/code, toolbar, same-session composer, paste/submit, scroll preservation, native fallback and draft guards passed.');
} finally { await browser?.close(); chatCleanup(); await service.close(); await rm(repo, { recursive: true, force: true }); }

function chatCleanup() { for (const chat of service.sessions.items.values()) chat.process = null; }
