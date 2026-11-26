// Production service and built UI, native SDK file reads, no model inference.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { writeClaudeHistory } from './claude-history-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const original = { ...process.env }, base = await mkdtemp(path.join(os.tmpdir(), 'mik-provider-history-ui-'));
let browser, source, target, calls = 0;
try {
  browser = await chromium.launch({ headless: true, env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'chrome' });
  for (const key of Object.keys(process.env)) if (!/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) delete process.env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR']) { process.env[key] = path.join(base, key); await mkdir(process.env[key]); }
  const hub = async name => {
    const repo = path.join(base, name);
    for (const directory of ['workspace', 'projects', 'knowledge']) await mkdir(path.join(repo, directory), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}'); await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
    const service = await createService({ repo, uiDir, mcpOptions: { home: process.env.HOME, env: process.env }, profileOptions: { root: path.join(base, `${name}-accounts`), claudeIdentity: async () => ({ status: 'logged-in', identity: 'a'.repeat(64) }) } }, factory);
    service.sessions.captureTools = async () => ({});
    service.sessions.createGraphicalRuntime = options => {
      const fixture = claudeFixture(options.session.nativeId, { commands: [{ name: 'fixture-context', description: 'Fixture context' }, { name: 'compact', builtin: true }] });
      return new ClaudeChat({ ...options, transportFactory: input => { const wire = fixture.factory(input), send = wire.send.bind(wire); wire.send = line => { if (JSON.parse(line).type === 'user') calls++; send(line); }; return wire; } });
    };
    return service;
  };
  const request = async (service, route, body = {}, method = 'POST') => {
    const response = await fetch(service.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, value.error); return value;
  };
  source = await hub('source');
  const nativeId = randomUUID(), native = await writeClaudeHistory(process.env.CLAUDE_CONFIG_DIR, source.sessions.repo, nativeId, 180), originalTranscript = await readFile(native.file, 'utf8');
  const imported = await source.sessions.importConversation({ agent: 'claude', nativeId, name: 'Native CLI history', cwd: source.sessions.repo });
  // A retained CLI tab after its native process has exited: no real CLI starts.
  const cli = source.sessions.get(imported.id); cli.open = true; source.sessions.changed(cli);
  await request(source, `/sessions/${cli.id}/focus`);
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(source.urls.chats);
  // Interface conversion is a maintained compatibility service operation, no
  // longer an exposed navigation action. Exercise that boundary explicitly.
  await request(source, `/sessions/${cli.id}/interface`, { chatInterface: 'chat' });
  await page.reload();
  const chat = page.getByRole('region', { name: 'Claude graphical chat', exact: true });
  await expect(chat).toBeVisible();
  const runtime = source.sessions.get(cli.id).graphical;
  await expect.poll(() => runtime.snapshot().items.filter(item => item.type === 'agentMessage').length).toBe(50);
  // Virtualized turns mount only the reading window, not all 50 saved replies.
  await expect.poll(() => chat.getByRole('article', { name: 'Claude response', exact: true }).count()).toBeGreaterThan(0);
  const olderResponse = page.waitForResponse(response => response.url().endsWith('/chat') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'history');
  await chat.getByRole('button', { name: 'Load older messages', exact: true }).click();
  const olderPage = await (await olderResponse).json();
  assert.equal(olderPage.items.length, 100);
  assert.equal(olderPage.items.filter(item => item.type === 'agentMessage').length, 50);
  for (const item of olderPage.items) assert.ok(runtime.historyReferences.has(item.id));
  await chat.getByRole('textbox', { name: 'Message Claude', exact: true }).focus(); await page.keyboard.press('Control+f');
  const search = chat.getByRole('textbox', { name: 'Search conversation', exact: true });
  await search.fill('ancient-needle');
  const hit = chat.getByRole('list', { name: 'History search results' }).getByRole('button').filter({ hasText: 'ancient-needle' });
  await expect(hit).toHaveCount(1); await hit.click();
  await expect(chat.locator('[data-search-target]')).toContainText('ancient-needle');
  await chat.getByRole('button', { name: 'Close conversation search', exact: true }).click();
  await chat.getByRole('button', { name: /^Back to latest/ }).click();
  const reference = path.join(source.sessions.repo, 'knowledge', 'fixture.txt'); await writeFile(reference, 'Synthetic available attachment');
  await runtime.attach([reference]);
  await runtime.composer.add({ type: 'skill', name: 'fixture-context', path: 'native:fixture-context' });
  const quoteSource = [...runtime.loadedHistory.values()].find(item => item.text.includes('ancient-needle'));
  await runtime.composer.add({ type: 'quote', itemId: quoteSource.id, text: quoteSource.text });
  await chat.getByRole('textbox', { name: 'Message Claude', exact: true }).fill('Retained portable draft');
  await expect.poll(() => runtime.draft).toBe('Retained portable draft');
  await request(source, `/sessions/${cli.id}`, {}, 'DELETE'); await source.sessions.persist();
  const exported = await request(source, '/workspace/export', { folder: base, chats: 'full' });
  target = await hub('target'); await request(target, '/workspace/import', { path: exported.path });
  await request(target, `/sessions/${cli.id}/resume`); await page.goto(target.urls.chats);
  await expect(chat.getByRole('textbox', { name: 'Message Claude', exact: true })).toHaveValue('Retained portable draft');
  await expect(chat.getByLabel('Draft attachments')).toContainText('fixture.txt');
  await expect(chat.getByLabel('Prompt context')).toContainText('/fixture-context');
  await expect(chat.getByLabel('Prompt context')).toContainText('ancient-needle');
  assert.equal(target.sessions.get(cli.id).graphical.composer.items.length, 2);
  await expect(chat.getByText('Delivery is uncertain.', { exact: false })).toHaveCount(0);
  assert.equal(target.sessions.get(cli.id).graphical.snapshot().uncertain, false);
  assert.equal(target.sessions.get(cli.id).graphical.attachments[0], path.join(target.sessions.repo, 'knowledge', 'fixture.txt'));
  assert.equal(calls, 0); assert.equal(await readFile(native.file, 'utf8'), originalTranscript); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, '.cache/provider-history-ui.png') }); await page.close();
  console.log('PASS Claude production UI: CLI opening, 360 native messages, pagination, full search/reveal and full portable draft/reference round-trip; zero inference.');
} finally {
  await browser?.close(); await source?.close(); await target?.close();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);
  await cleanupFixtures();
}
