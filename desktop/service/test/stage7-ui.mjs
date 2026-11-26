// Production UI/service, synthetic native wires, isolated Hub and accounts.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const runtimeRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-stage7-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Subagent fixture'), codex = graphicalFixture(); let claude;
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    claude = claudeFixture(options.session.nativeId); return new ClaudeChat({ ...options, transportFactory: claude.factory });
  };
  const sessions = [];
  for (const agent of ['codex', 'claude']) sessions.push(await service.sessions.create({ agent, name: `${agent} subagents`, chatInterface: 'chat', cwd: repo, accountProfileId: agent === 'codex' ? profile.id : undefined }));
  const cr = service.sessions.get(sessions[0].id).graphical, ar = service.sessions.get(sessions[1].id).graphical;
  for (let index = 0; index < 2; index++) {
    const id = `fixture-child-${index}`;
    codex.history.set(id, Array.from({ length: 30 }, (_, number) => ({ id: `${id}-${number}`, type: 'agentMessage', text: `Codex child ${index} activity ${number}\n` + 'Synthetic context. '.repeat(15) })));
    codex.children[0].notify('item/completed', { threadId: cr.threadId, turnId: 'agent-turn', item: { id: `spawn-${index}`, type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: `Inspect fixture ${index}`, receiverThreadIds: [id], agentsStates: { [id]: { status: 'running', message: 'Inspecting synthetic data' } } } });
  }
  await ar.submit('slow'); const wire = [...claude.transports][0];
  for (let index = 0; index < 2; index++) {
    const id = `toolu_child_${index}`;
    wire.emit({ type: 'assistant', session_id: ar.session.nativeId, message: { id: `spawn-${index}`, content: [{ type: 'tool_use', id, name: 'Agent', input: { description: `Claude child ${index}`, subagent_type: 'general-purpose', prompt: `Inspect synthetic data ${index}` } }] } });
    for (let number = 0; number < 30; number++) wire.emit({ type: 'assistant', session_id: ar.session.nativeId, parent_tool_use_id: id, message: { id: `${id}-${number}`, content: [{ type: 'text', text: `Claude child ${index} activity ${number}\n` + 'Synthetic context. '.repeat(15) }] } });
  }
  const file = path.join(repo, 'fixture.txt'); await writeFile(file, 'one\ntwo\nthree\nfour\nfive\nsix\nnew line\n');
  wire.emit({ type: 'assistant', session_id: ar.session.nativeId, message: { id: 'edit', content: [{ type: 'tool_use', id: 'edit-tool', name: 'Edit', input: { file_path: file, old_string: 'old line', new_string: 'new line' } }] } });
  wire.emit({ type: 'user', session_id: ar.session.nativeId, message: { content: [{ type: 'tool_result', tool_use_id: 'edit-tool', content: 'Updated' }] }, tool_use_result: { filePath: file, structuredPatch: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-old line', '+new line'] }] } });
  wire.complete('Parent response stays separate.');
  const request = async (id, data) => fetch(`${service.origin}/api/sessions/${id}/chat`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }), workspace = await browser.newPage({ viewport: { width: 1100, height: 960 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); workspace.on('pageerror', error => errors.push(error.message)); await workspace.goto(service.urls.workspace);
  let reads = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/chat') && request.postDataJSON()?.action === 'agent-read') reads++; });
  for (const session of sessions) {
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${session.agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), panel = chat.getByRole('region', { name: 'Subagents', exact: true });
    const toggle = panel.getByRole('button', { name: /^Subagents ·/ }); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const before = reads; await page.waitForTimeout(2200); assert.equal(reads, before, 'Collapsed panels must not poll child transcripts');
    await toggle.click(); await expect(panel.getByRole('tab')).toHaveCount(2);
    const transcript = panel.getByLabel('Subagent transcript', { exact: true });
    await expect(transcript).toContainText(`${session.agent === 'codex' ? 'Codex' : 'Claude'} child 0 activity`);
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    const panelBounds = await panel.boundingBox(), composerBounds = await chat.locator('.graphical-composer').boundingBox(); assert.ok(panelBounds.y + panelBounds.height <= composerBounds.y + 1);
    await transcript.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    if (session.agent === 'codex') codex.history.get('fixture-child-0').push({ id: 'live', type: 'agentMessage', text: 'LATEST_CODEX_CHILD' });
    else wire.emit({ type: 'assistant', session_id: ar.session.nativeId, parent_tool_use_id: 'toolu_child_0', message: { id: 'live', content: [{ type: 'text', text: 'LATEST_CLAUDE_CHILD' }] } });
    await expect(transcript).toContainText(`LATEST_${session.agent.toUpperCase()}_CHILD`, { timeout: 8000 }); assert.equal(await transcript.evaluate(element => element.scrollTop), 0, 'Polling must not pull a reader to the bottom');
    await panel.getByRole('tab').nth(1).click(); await expect(transcript).toContainText(`${session.agent === 'codex' ? 'Codex' : 'Claude'} child 1 activity`);
    await page.screenshot({ path: path.join(root, `.cache/stage7-${session.agent}-subagents.png`) });
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.setViewportSize({ width: 1280, height: 960 });
    const denied = await request(session.id, { action: 'agent-read', threadId: 'foreign-child', runtimeId: service.sessions.get(session.id).graphical.runtimeId }); assert.equal(denied.ok, false);
    await toggle.click(); await page.waitForTimeout(200); const closedReads = reads; await page.waitForTimeout(2300); assert.equal(reads, closedReads);
    if (session.agent === 'claude') {
      for (let index = 0; index < 2; index++) wire.emit({ type: 'system', session_id: ar.session.nativeId, subtype: 'task_notification', task_id: `ui-task-${index}`, tool_use_id: `toolu_child_${index}`, status: 'completed', summary: 'Synthetic completed result' });
      const baseline = claude.calls.filter(call => call.type === 'user').length;
      await chat.getByLabel('Chat details', { exact: true }).click(); await chat.getByRole('tab', { name: 'Actions', exact: true }).click(); await chat.getByRole('button', { name: 'Review changes', exact: true }).click();
      await chat.getByRole('button', { name: 'Prepare review draft', exact: true }).click();
      await expect(chat.getByRole('textbox', { name: 'Message Claude', exact: true })).toHaveValue(/Review the current working-tree changes/);
      assert.equal(claude.calls.filter(call => call.type === 'user').length, baseline);
      await page.keyboard.press('Escape');
      await chat.getByRole('button', { name: 'View changes', exact: true }).click();
      await expect(workspace.locator('.changes-inspector')).toContainText('fixture.txt'); await expect(workspace.locator('.changes-inspector')).toContainText('+new line');
      await workspace.getByRole('button', { name: 'Current file', exact: true }).click(); await expect(workspace.getByLabel('Current file preview', { exact: true })).toContainText('new line');
    }
  }
  assert.equal(codex.calls.some(call => call.method === 'turn/start'), false); assert.equal(claude.calls.filter(call => call.type === 'user').length, 1);
  assert.deepEqual(errors, []); console.log('PASS stage7 production UI: shared read-only subagent panels, scoped reads, live refresh, preserved scroll, collapse stops polling, narrow layouts, native recorded diff/current-file inspector and review draft without inference.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
