import { testBrowserEnvironment } from './fixtures.mjs';
// Production service/React with a synthetic native worker; no model/auth calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-message-actions-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(native, 'config.toml'), '# Synthetic');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Message fixture');
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const turns = new Map(), transport = graphicalFixture({ turnHistory: turns, completeBeforeResponse: true });
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const created = await service.sessions.create({ name: 'Original fixture', agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, graphicalModel: 'fixture-model', effort: 'medium', codexPermissions: 'bypass' });
  const source = service.sessions.get(created.id), runtime = source.graphical;
  const recorded = [1, 2].map(number => ({ id: `turn-${number}`, status: 'completed', items: [{ id: `user-${number}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${number}` }] }, { id: `answer-${number}`, type: 'agentMessage', text: `Answer ${number}`, status: 'completed' }] }));
  turns.set(source.nativeId, recorded);
  for (const turn of recorded) { runtime.rememberTurn(turn); for (const item of turn.items) runtime.upsert(item, { turnId: turn.id }); }
  service.sessions.changed(source);
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = async (url, data) => { const response = await fetch(service.origin + url, { method: 'POST', headers, body: JSON.stringify(data) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
  await post(`/api/sessions/${source.id}/focus`, {});
  browser = await chromium.launch({ env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'msedge', headless: true }); const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true });
  const composer = chat.getByRole('textbox', { name: 'Message Codex', exact: true });
  await expect(chat.getByText('Answer 2', { exact: true })).toBeVisible();
  await composer.fill('Keep original draft');
  await expect.poll(() => runtime.draft).toBe('Keep original draft');
  await chat.locator('[data-chat-item="answer-1"]').hover();
  await chat.locator('[data-chat-item="answer-1"]').getByRole('button', { name: 'Branch from this response' }).click();
  await expect(chat.getByText('Forked conversation', { exact: false })).toBeVisible();
  await expect(chat.getByText('Answer 1', { exact: true })).toBeVisible();
  await expect(chat.getByText('Answer 2', { exact: true })).toHaveCount(0);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
  const branch = service.sessions.get(service.sessions.list().find(item => item.id !== source.id && item.messageOrigin?.kind === 'branch').id);
  const origin = branch.messageOrigin;
  branch.messageOrigin = { ...origin, sessionId: null, unavailable: true }; branch.graphical.changed();
  await expect(chat.getByRole('button', { name: 'Original not included', exact: true })).toBeDisabled();
  branch.messageOrigin = { ...origin, unavailable: false }; branch.graphical.changed();
  await expect(chat.getByRole('button', { name: 'Original conversation', exact: true })).toBeEnabled();
  await chat.getByRole('button', { name: 'Original conversation', exact: true }).click();
  await expect(composer).toHaveValue('Keep original draft');
  await chat.locator('[data-chat-item="user-2"]').hover();
  await chat.locator('[data-chat-item="user-2"]').getByRole('button', { name: 'Edit and branch' }).click();
  await expect(composer).toHaveValue('Prompt 2');
  await expect(chat.getByText('Answer 2', { exact: true })).toHaveCount(0);
  const payload = { kind: 'retry', itemId: 'answer-2', requestId: randomUUID() };
  const results = await Promise.all([post(`/api/sessions/${source.id}/messageaction`, payload), post(`/api/sessions/${source.id}/messageaction`, payload)]);
  assert.equal(results[0].session.id, results[1].session.id);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  // Recreating a graphical runtime loses all runtime-local caches. Recovery
  // must use the durable action receipt, not infer again with the same ID.
  runtime.messageActionReceipts?.clear(); source.providerMessageReceipts?.clear();
  const recovered = await post(`/api/sessions/${source.id}/messageaction`, payload);
  assert.equal(recovered.session.id, results[0].session.id);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(runtime.draft, 'Keep original draft'); assert.equal(turns.get(source.nativeId).length, 2);
  assert.deepEqual(errors, []);
  console.log('Message actions UI passed: branch anchors, edit draft, original draft retention, idempotent HTTP retry and one synthetic submission.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
