// Compiled chat and Workspace rendering; synthetic providers, no native inference.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

const invalid = 'sequenceDiagram\nparticipant White\nparticipant Black\nNote over White,Black: Exchange ends; turn incomplete; Black must respond';
const valid = invalid.replaceAll(';', '#59;');
const survey = process.argv.includes('--survey'), evidence = path.resolve('.cache', survey ? 'mermaid-error-before' : 'mermaid-error-after');
let service, browser; const wires = [], checks = [];
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-mermaid-error-')), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic diagrams'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: wire.spawnChild }); const fixture = claudeFixture(options.session.nativeId); wires.push(fixture); return new ClaudeChat({ ...options, transportFactory: fixture.factory }); };
  browser = await chromium.launch({ headless: true, channel: 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), workspace = await context.newPage(), errors = [];
  for (const p of [page, workspace]) p.on('pageerror', error => errors.push(error.message));
  await workspace.goto(service.urls.workspace);
  for (const agent of ['codex', 'claude']) {
    await page.setViewportSize({ width: 480, height: 900 });
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    const item = { id: 'diagram-result', type: 'agentMessage', phase: 'final_answer', turnId: 'diagram-turn', status: 'completed', details: '' };
    const update = source => {
      const value = { ...item, text: '## Visual overview\n\n```mermaid\n' + source + '\n```\n\nThe surrounding response remains readable.' };
      const turn = { id: 'diagram-turn', status: 'completed' };
      if (agent === 'codex') { runtime.items = new Map([[item.id, value]]); runtime.turns = new Map([[turn.id, turn]]); runtime.turnId = null; }
      else Object.assign(runtime.protocol.state, { items: [value], turns: [turn], status: 'ready' });
      runtime.changed();
    };
    update(invalid);
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    await page.bringToFront();
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    const block = chat.locator('.chat-rich-block');
    await expect(block).toContainText(survey ? 'Mermaid Error' : 'Diagram could not be rendered', { timeout: 20000 });
    await block.screenshot({ path: path.join(evidence, `${agent}-invalid.png`) });
    const errorHeight = await block.evaluate(el => el.getBoundingClientRect().height);
    if (survey) { checks.push({ agent, visibleError: (await block.innerText()).slice(-2600), height: await block.evaluate(el => el.getBoundingClientRect().height) }); continue; }
    const fallback = block.getByRole('region', { name: 'Diagram error', exact: true });
    assert.ok(await fallback.evaluate(el => el.getBoundingClientRect().height < 180));
    await expect(block.getByRole('navigation', { name: 'Diagram controls', exact: true })).toBeHidden();
    await expect(fallback).toContainText('#59;');
    assert.ok(!(await fallback.innerText()).includes('SOLID_OPEN_ARROW'));
    await block.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')), invalid);
    await fallback.getByText('Diagram source', { exact: true }).click();
    // Streamdown passes the code fence's terminating newline to its renderer.
    assert.equal(await fallback.locator('pre').first().textContent(), invalid + '\n');
    await fallback.getByText('Diagram source', { exact: true }).click();
    await fallback.getByText('Technical details', { exact: true }).click();
    await expect(fallback).toContainText('SOLID_OPEN_ARROW');
    await fallback.getByText('Technical details', { exact: true }).click();
    update(valid);
    try { await expect(block.locator('[data-streamdown="mermaid"] svg')).toBeVisible({ timeout: 20000 }); }
    catch (error) { const snapshot = await (await fetch(`${service.origin}/api/sessions/${session.id}/chat`,{headers:{Authorization:`Bearer ${service.token}`}})).json(); console.log('Snapshot recovery source:',JSON.stringify(snapshot.items)); console.log('Recovery state:', await block.textContent()); await block.screenshot({path:path.join(evidence, `${agent}-recovery-failure.png`)}); throw error; }
    await expect(block.getByRole('region', { name: 'Diagram error', exact: true })).toHaveCount(0);
    await block.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')), valid);
    await block.screenshot({ path: path.join(evidence, `${agent}-valid.png`) });
    for (const width of [320, 1000]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1)); }
    await page.setViewportSize({ width: 390, height: 900 });
    update(['flowchart TD', ...Array.from({ length: 14 }, (_, index) => `n${index}[Tall stage ${index}] --> n${index + 1}`)].join('\n'));
    const tall = block.locator('[data-streamdown="mermaid"] svg');
    await expect(tall).toContainText('Tall stage 13', { timeout: 20000 });
    await expect.poll(() => tall.evaluate(element => {
      const canvas = element.closest('.diagram-pan').getBoundingClientRect(), diagram = element.getBoundingClientRect();
      return diagram.top >= canvas.top && diagram.bottom <= canvas.bottom && Math.abs(diagram.left + diagram.width / 2 - canvas.left - canvas.width / 2) < 2;
    })).toBe(true);
    update(invalid);
    await expect(block.getByRole('region', { name: 'Diagram error', exact: true })).toBeVisible({ timeout: 20000 });
    await block.getByRole('button', { name: 'Open code in Workspace', exact: true }).click();
    const preview = workspace.locator('.workspace-rich-preview:visible');
    await expect(preview.getByRole('region', { name: 'Diagram error', exact: true })).toBeVisible({ timeout: 20000 });
    await expect(preview.getByRole('button', { name: 'Diagram minimap', exact: true })).toHaveCount(0);
    await preview.screenshot({ path: path.join(evidence, `${agent}-workspace-invalid.png`) });
    checks.push({ agent, errorHeight, compactError: true, sourcePreserved: true, detailsOnDemand: true, workspace: true, recovery: true, validCopy: true, noOverflow: true });
  }
  assert.deepEqual(errors, []); assert.ok(!wire.calls.some(call => call.method === 'turn/start')); assert.ok(wires.every(wire => !wire.calls.some(call => call.type === 'user')));
  await writeFile(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks));
} finally { await browser?.close(); await service?.close(); for (const wire of wires) await wire.close(); await cleanupFixtures(); }
