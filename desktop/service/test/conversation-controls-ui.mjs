// Real UI/service, isolated transcripts and fake PTYs: no model or user session.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createService } from '../server.mjs';
import { claudeTranscript } from '../native-events.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-controls-ui-'));
const repo = path.join(base, 'hub'), linked = path.join(base, 'project'), uiDir = path.join(base, 'ui');
await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(linked);
await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
await cp(path.join(root, 'dist'), uiDir, { recursive: true }); await cp(path.join(root, 'public/assets'), path.join(uiDir, 'assets'), { recursive: true });
const previousCodex = process.env.CODEX_HOME, previousClaude = process.env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = path.join(base, 'codex'); process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
const service = await createService({ repo, uiDir, mcpOptions: { home: path.join(base, 'home'), env: {} } });
let browser;
try {
  const project = await service.projects.save({ name: 'Game', repositoryPath: linked });
  const card = await service.projects.createCard({ projectId: project.id, title: 'Development', repositoryId: 'primary' });
  const keys = new Map();
  service.sessions.launch = async (session, resumeId, boundary) => {
    assert.ok(resumeId && boundary.fork);
    if (session.agent === 'codex') session.nativeId = randomUUID();
    session.process = { write: key => keys.get(session.id).push(key), resize() {}, kill() {} };
    keys.set(session.id, []); session.status = 'running'; service.sessions.changed(session);
  };
  const sources = [];
  const nativeScreens = new Map();
  const read = service.sessions.read.bind(service.sessions);
  service.sessions.read = async (id, lines) => ({ ...await read(id, lines), ...(nativeScreens.has(id) ? { screen: nativeScreens.get(id) } : {}) });
  for (const agent of ['codex', 'claude']) {
    const nativeId = randomUUID();
    const transcript = agent === 'codex' ? path.join(process.env.CODEX_HOME, 'sessions/2026/09/30', `rollout-fixture-${nativeId}.jsonl`) : await claudeTranscript(linked, nativeId);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify(agent === 'codex' ? { type: 'session_meta', payload: { id: nativeId, cwd: linked } } : { type: 'user', sessionId: nativeId, message: { content: 'Fixture' } }) + '\n');
    const session = service.sessions.make({ id: randomUUID(), agent, name: `${agent} source`, cwd: linked, projectId: project.id, repositoryId: 'primary', cardId: card.id, nativeId, status: 'running', activity: 'idle', open: true, cols: 90, rows: 32, createdAt: new Date().toISOString() });
    let level = 2, stage = 'idle';
    const effortScreen = () => agent === 'codex' ? `Select Reasoning Level for GPT-6.1-Sol\n${['Low', 'Medium', 'High'].map((label, i) => `${i === level ? '›' : ' '} ${i + 1}. ${label}`).join('\n')}\nenter default · s session · esc back` : `Effort\n${'─'.repeat([1, 10, 20][level])}▲${'─'.repeat(24 - [1, 10, 20][level])}\nlow     medium     high\ns for this session only · esc cancel`;
    nativeScreens.set(session.id, agent === 'codex' ? '› Ask Codex to do anything' : '❯');
    keys.set(session.id, []); session.process = { write: key => {
      keys.get(session.id).push(key);
      if (key === '/model' || key === '/effort') { stage = key; nativeScreens.set(session.id, `${agent === 'codex' ? '›' : '❯'} ${key}`); }
      else if (key === '\r' && stage === '/model') { stage = 'model'; nativeScreens.set(session.id, 'Select Model and Effort\n› 1. GPT-6.1-Sol (current)\n  2. GPT-6-Luna\nenter select · esc back'); }
      else if (key === '\r' && stage === '/effort' || key === '1' && stage === 'model') { stage = 'effort'; nativeScreens.set(session.id, effortScreen()); }
      else if (stage === 'effort' && ['\x1b[A', '\x1b[D', '\x1b[B', '\x1b[C'].includes(key)) { level += ['\x1b[A', '\x1b[D'].includes(key) ? -1 : 1; nativeScreens.set(session.id, effortScreen()); }
      else if (stage === 'effort' && key === 's') { stage = 'idle'; nativeScreens.set(session.id, agent === 'codex' ? 'Model changed to gpt-6.1-sol low\n› Ask Codex to do anything' : 'Effort set to low for this session\n❯'); }
    }, resize() {}, kill() {} };
    service.sessions.items.set(session.id, session); await service.sessions.hydrate(session);
    await new Promise(resolve => session.terminal.write('Fixture prompt\r\n> ', resolve)); sources.push(session);
  }
  service.sessions.changed(sources[0]);
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 650, height: 750 } }); const errors = []; page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(service.urls.chats);
  for (const source of sources) {
    await page.getByRole('tab', { name: new RegExp(source.name) }).click();
    const send = page.getByRole('button', { name: 'Send typed CLI prompt', exact: true }); await send.waitFor();
    assert.equal(await page.locator('.chat-status').getByRole('button', { name: 'Send typed CLI prompt' }).count(), 1);
    assert.equal(await page.locator('.terminal-area .terminal-turn-control').count(), 0);
    await page.locator('.xterm-helper-textarea').pressSequentially('hello'); await send.click();
    await page.waitForTimeout(100); assert.ok(keys.get(source.id).includes('\r'));
    source.activity = 'working'; service.sessions.changed(source);
    await page.getByRole('button', { name: 'Interrupt response', exact: true }).click();
    await page.waitForTimeout(100); assert.equal(keys.get(source.id).at(-1), '\x1b'); assert.ok(source.process);
    source.activity = 'idle'; source.attention = false; service.sessions.changed(source);
    await page.getByRole('button', { name: 'Fork selected conversation', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.chat-tab').length >= count, 3 + sources.indexOf(source));
    const fork = service.sessions.list().find(item => item.name === `Fork · ${source.name}`);
    assert.ok(fork && fork.nativeId !== source.nativeId); assert.equal(fork.cardId, source.cardId); assert.equal(fork.projectId, source.projectId); assert.equal(fork.repositoryId, source.repositoryId);
  }
  for (const source of sources) {
    source.activity = 'idle'; service.sessions.changed(source);
    await page.getByRole('tab', { name: new RegExp(source.name) }).first().click();
    await page.getByRole('button', { name: 'Chat reasoning', exact: true }).click();
    await page.locator('.chat-model-menu').getByRole('button', { name: /^low$/i }).click();
    await page.waitForTimeout(150);
    assert.equal(source.effort, 'low'); assert.equal(keys.get(source.id).at(-1), 's');
  }
  await page.getByRole('tab', { name: new RegExp(sources[0].name) }).first().click();
  await page.setViewportSize({ width: 470, height: 580 });
  const button = page.getByRole('button', { name: 'Send typed CLI prompt', exact: true }); await button.waitFor();
  const box = await button.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 470);
  await page.screenshot({ path: path.join(base, 'controls.png') }); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'CLI Send/Stop, native fork dispatch/associations and narrow layout passed with fake PTYs.', screenshot: path.join(base, 'controls.png') }));
} finally {
  await browser?.close(); for (const session of service.sessions.items.values()) session.process = null; await service.close();
  if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
}
