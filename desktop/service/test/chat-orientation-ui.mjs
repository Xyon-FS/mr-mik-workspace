import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-chat-scope-ui-'));
const repo = path.join(base, 'hub'), linked = path.join(base, 'Unity');
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await mkdir(linked);
await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
const service = await createService({ repo, uiDir: path.join(root, 'dist') });
let browser;
try {
  const project = await service.projects.save({ name: 'Exercise Unity', repositoryPath: linked });
  const card = await service.projects.createCard({ projectId: project.id, repositoryId: 'primary', title: 'Exercise Unity Develop' });
  const chat = service.sessions.make({ id: 'scope-ui-fixture', name: 'Card chat', agent: 'codex', cwd: linked, projectId: project.id, repositoryId: 'primary', cardId: card.id, open: true, status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  service.sessions.items.set(chat.id, chat);
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 590, height: 780 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const scopes = page.locator('.chat-scopes');
  await scopes.getByText('Exercise Unity Develop', { exact: false }).waitFor();
  assert.match(await scopes.innerText(), /Card Exercise Unity Develop/);
  assert.doesNotMatch(await scopes.innerText(), /Work in|Hub Exercise Unity/);
  assert.match(await scopes.getAttribute('title'), /Working folder:/);
  assert.match(await page.getByRole('tab', { name: /Card chat/ }).innerText(), /Card chat\s+Exercise Unity · Unity/);
  await page.screenshot({ path: path.join(base, 'chat-scope.png') });
  assert.deepEqual(errors, []);
  console.log('Chat scope UI passed: tabs identify workspace and working project; active context identifies the card.');
} finally { await browser?.close(); service.sessions.items.clear(); await service.close(); }
