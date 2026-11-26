// Delayed and rejected delivery against production UI. Synthetic providers only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-send-receipt-')), root = path.resolve('.'), at = process.argv.indexOf('--portable'), portable = at < 0 ? null : path.resolve(process.argv[at + 1]);
const runtimeRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
let browser, service; const wires = [], releases = [];
try {
 const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
 service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
 service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
 const profile = await service.profiles.create('Send receipt'), codex = graphicalFixture();
 service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild }); const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
 browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() }); const page = await browser.newPage({ viewport: { width: 650, height: 950 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
 for (const agent of ['codex', 'claude']) {
  const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} send`, ...(agent === 'codex' ? { accountProfileId: profile.id } : {}) }), runtime = service.sessions.get(session.id).graphical;
  let release, calls = 0; runtime.submit = async () => { calls++; await new Promise(resolve => { release = resolve; releases.push(resolve); }); return { delivered: true }; };
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), draft = chat.getByRole('textbox', { name: `Message ${agent === 'codex' ? 'Codex' : 'Claude'}`, exact: true });
  await expect(draft).toBeEnabled(); await draft.fill('A delayed message'); await draft.press('Enter');
  const pending = chat.locator('[data-local-message]').filter({ hasNot: page.getByRole('status') }); await expect(pending).toContainText('A delayed message', { timeout: 1000 }); await expect(draft).toHaveValue(''); await expect(pending.getByRole('status')).toHaveCount(0); await expect.poll(() => calls).toBe(1);
  await draft.fill('New draft while sending'); release(); await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled(); await expect(draft).toHaveValue('New draft while sending'); await expect(pending.getByRole('status')).toHaveCount(0);
  const item = { id: 'native-echo', type: 'userMessage', text: 'A delayed message', turnId: 'turn', status: 'completed', details: '' };
  if (agent === 'codex') runtime.items.set(item.id, item); else runtime.protocol.state.items.push(item); runtime.changed(); await expect(pending).toHaveCount(0); await expect(chat.locator('[data-chat-item="native-echo"]')).toContainText('A delayed message');
  await page.waitForTimeout(100); if (agent === 'codex') runtime.items.delete(item.id); else runtime.protocol.state.items = []; runtime.changed(); await page.waitForTimeout(300); await expect(pending).toHaveCount(0);
  runtime.submit = async () => { throw new Error('Synthetic send rejection'); }; await draft.fill('Keep rejected draft'); await draft.press('Enter'); await expect(chat.getByRole('alert')).toContainText('Synthetic send rejection'); await expect(draft).toHaveValue('Keep rejected draft'); await expect(pending).toHaveCount(0);
  release = null; runtime.submit = async () => { await new Promise(resolve => { release = resolve; releases.push(resolve); }); throw new Error('Delayed synthetic rejection'); };
  await draft.fill('Original rejected message'); await draft.press('Enter'); await expect(draft).toHaveValue(''); await expect(pending).toContainText('Original rejected message');
  await draft.fill('Do not overwrite this newer draft'); await expect.poll(() => typeof release).toBe('function'); release(); await expect(chat.getByRole('alert')).toContainText('Delayed synthetic rejection'); await expect(draft).toHaveValue('Do not overwrite this newer draft'); await expect(chat.getByRole('article', { name: 'Message not sent', exact: true })).toContainText('Original rejected message');
const away=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,name:'AUDIT AWAY '+agent,...(agent==='codex'?{accountProfileId:profile.id}:{})});let rejectAway;runtime.submit=async()=>{await new Promise(resolve=>{rejectAway=resolve;releases.push(resolve)});throw new Error('Rejected while away')};await draft.fill('UNSENT-NAVIGATION-LOSS');await draft.press('Enter');await expect(draft).toHaveValue('');await new Promise(resolve=>setTimeout(resolve,450));await expect.poll(()=>runtime.draft).toBe('');await page.getByRole('button',{name:'Find a chat',exact:true}).click();await page.getByRole('dialog',{name:'Find a chat',exact:true}).getByRole('button').filter({hasText:'AUDIT AWAY '+agent}).click();await expect(draft).toHaveValue('');rejectAway();await new Promise(resolve=>setTimeout(resolve,100));await page.getByRole('button',{name:'Find a chat',exact:true}).click();await page.getByRole('dialog',{name:'Find a chat',exact:true}).getByRole('button').filter({hasText:session.name}).click();await expect(draft).toBeEnabled();await expect(chat.getByRole('article', {name:'Message not sent',exact:true}).filter({hasText:'UNSENT-NAVIGATION-LOSS'})).toBeVisible(); await page.reload(); await expect(draft).toBeEnabled(); await expect(chat.getByRole('article', {name:'Message not sent',exact:true}).filter({hasText:'UNSENT-NAVIGATION-LOSS'})).toBeVisible();

 }
 assert.deepEqual(errors, []); assert.equal(codex.calls.some(call => call.method === 'turn/start'), false); assert.equal(wires.flatMap(wire => wire.calls).some(call => call.type === 'user'), false);
 console.log('PASS Codex/Claude failed sends survive navigation and page reload, alongside immediate receipts and preserved newer drafts. No inference.');
} finally { for (const release of releases) release(); await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }

