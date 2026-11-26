// Production service/UI with a synthetic multi-thread native protocol.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { CodexChat } from '../codex-chat.mjs';
import { pooledCodexFixture } from './codex-pooled-fixture.mjs';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-pooled-codex-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { CODEX_HOME: home, HOME: home, USERPROFILE: home } } });
  const first = await service.profiles.create('Synthetic A'), second = await service.profiles.create('Synthetic B'), wire = pooledCodexFixture();
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {};
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, workerPool: service.sessions.codexWorkers, spawnChild: wire.spawnChild });
  const a = await service.sessions.create({ agent: 'codex', cwd: repo, accountProfileId: first.id, chatInterface: 'chat', name: 'Pool A' });
  const b = await service.sessions.create({ agent: 'codex', cwd: repo, accountProfileId: first.id, chatInterface: 'chat', name: 'Pool B' });
  const ar = service.sessions.get(a.id).graphical, br = service.sessions.get(b.id).graphical;
  assert.equal(wire.children.length, 1); assert.equal(ar.transport, br.transport);
  browser = await chromium.launch({ headless: true, channel: 'msedge', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const focus = async id => {
    const response = await fetch(service.origin + `/api/sessions/${id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.ok(response.ok);
    await page.goto(service.urls.chats);
  };
  await focus(a.id);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true }), input = chat.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.fill('Synthetic A request'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => ar.turnId).not.toBeNull();
  await input.fill('Synthetic A guidance'); await input.press('Enter');
  await expect.poll(() => wire.calls.filter(call => call.method === 'turn/steer').length).toBe(1);
  await expect(input).toHaveValue('');
  await focus(b.id);
  await input.fill('Synthetic B request'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => br.turnId).not.toBeNull();
  const bTurn = br.turnId, approval = wire.children[0].approve(br.threadId);
  await expect(chat.getByRole('region', { name: 'Agent request', exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect.poll(() => wire.calls.find(call => call.id === approval && !call.method)?.result?.decision).toBe('decline');
  await focus(a.id);
  await expect(input).toHaveValue('');
  await chat.getByRole('button', { name: 'Interrupt response', exact: true }).click();
  await expect.poll(() => ar.snapshot().working).toBe(false); assert.equal(br.turnId, bTurn);
  await service.sessions.remove(a.id);
  assert.equal(br.closed, false); assert.equal(br.turnId, bTurn); assert.equal(wire.children[0].closed, undefined);
  await br.interrupt(); await focus(b.id);
  await expect(chat.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  // The account change path must detach/rebind just B and preserve native ID.
  service.sessions.permissionReady = async () => true;
  const nativeId = br.threadId;
  const c = await service.sessions.create({ agent: 'codex', cwd: repo, accountProfileId: first.id, chatInterface: 'chat', name: 'Pool C' });
  const cr = service.sessions.get(c.id).graphical; assert.equal(cr.transport, br.transport);
  await cr.submit('Synthetic C remains active'); const cTurn = cr.turnId;
  await service.sessions.setAccountProfile(b.id, second.id);
  const switched = service.sessions.get(b.id).graphical;
  assert.equal(switched.threadId, nativeId); assert.notEqual(switched.transport, br.transport);
  assert.equal(service.sessions.get(b.id).accountProfileId, second.id);
  assert.equal(cr.closed, false); assert.equal(cr.turnId, cTurn);
  // Refresh B's tools while another chat shares its replacement account worker.
  const d = await service.sessions.create({ agent: 'codex', cwd: repo, accountProfileId: second.id, chatInterface: 'chat', name: 'Pool D' });
  const dr = service.sessions.get(d.id).graphical; assert.equal(dr.transport, switched.transport);
  await dr.submit('Synthetic D remains active'); const dTurn = dr.turnId;
  await service.sessions.restartTools(service.sessions.get(b.id), { process: switched, inputAt: service.sessions.get(b.id).lastInputAt });
  const refreshed = service.sessions.get(b.id).graphical;
  assert.equal(refreshed.threadId, nativeId); assert.equal(refreshed.transport, dr.transport);
  assert.equal(dr.closed, false); assert.equal(dr.turnId, dTurn);
  assert.equal(wire.calls.filter(call => call.method === 'turn/start').length, 4);
  assert.deepEqual(errors, []);
  console.log('PASS pooled production UI: two roots/one worker, send, Steer, approval decline, Stop/close isolation, account switch and tools refresh preserve native ID and active siblings; synthetic local protocol only.');
} finally {
  await browser?.close(); await service?.close(); await cleanupFixtures();
}
