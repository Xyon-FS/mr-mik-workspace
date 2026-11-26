// Compiled application + real Codex event projection; synthetic native transport.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';

const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-codex-steps-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic step validation'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: wire.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo });
  const runtime = service.sessions.get(session.id).graphical;
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, turnId: 'steps', ...params } });
  notify('turn/started', { turn: { id: 'steps', status: 'inProgress' } });
  const items = [
    { id: 'question', type: 'userMessage', text: 'Inspect the implementation and report the result.' },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'I will inspect **source files**, then verify the result.' },
    { id: 'reason', type: 'reasoning', summary: ['Public **progress** summary.'], content: ['NEVER_RENDER_PRIVATE'] },
    { id: 'command', type: 'commandExecution', command: "printf '# **literal**\\n'\n  cat source.ts", cwd: repo, commandActions: [{ type: 'read', command: 'cat source.ts', name: 'source', path: 'source.ts' }], aggregatedOutput: '  first output\n', status: 'inProgress' },
    { id: 'tool', type: 'mcpToolCall', server: 'fixture', tool: 'lookup', arguments: { query: 'configuration', token: 'NEVER_RENDER_SECRET' }, result: { content: [{ type: 'text', text: 'Two matches found.' }], structuredContent: { count: 2, password: 'NEVER_RENDER_SECRET' } } },
    { id: 'dynamic', type: 'dynamicToolCall', tool: 'validate', success: false, contentItems: [{ type: 'text', text: 'Validation did not pass.' }] },
    { id: 'web', type: 'webSearch', query: 'API reference', action: { type: 'search', queries: ['API reference', 'Version notes'] }, results: [{ title: 'Reference', url: 'https://example.invalid/reference' }] },
    { id: 'open', type: 'webSearch', action: { type: 'openPage', url: 'javascript:window.bad=true' } },
    { id: 'find', type: 'webSearch', action: { type: 'findInPage', url: 'https://example.invalid/reference', pattern: 'version < 2' } },
    { id: 'changes', type: 'fileChange', changes: [{ path: path.join(repo, 'source.ts'), kind: { type: 'update', move_path: path.join(repo, 'renamed.ts') }, diff: '--- a/source.ts\n+++ b/renamed.ts\n@@ -1 +1 @@\n-old\n+new' }] },
    { id: 'proposed', type: 'plan', text: '1. Inspect\n2. Validate' },
    { id: 'hook', type: 'hookPrompt', fragments: [{ hookRunId: 'hook', text: 'Use the repository conventions.' }] },
    { id: 'function', type: 'functionCallOutput', name: 'lookup', output: [{ type: 'input_text', text: 'Recorded lookup result' }] },
    { id: 'subagent', type: 'subAgentActivity', kind: 'spawn', agentPath: 'reviewer', model: 'fixture-model', agentThreadId: 'sub' },
    { id: 'sleep', type: 'sleep', durationMs: 1200 },
    { id: 'imagefail', type: 'imageGeneration', status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'image' } },
    { id: 'compaction', type: 'contextCompaction' },
    { id: 'review-start', type: 'enteredReviewMode', review: 'Review current changes' },
    { id: 'review', type: 'exitedReviewMode', review: JSON.stringify({ overall_explanation: 'No actionable review findings.', findings: [] }) },
    { id: 'future', type: 'futureNativeItem', description: 'A recorded future operation.', hidden: 'NEVER_RENDER_PRIVATE' },
  ];
  for (const item of items) notify(item.status === 'inProgress' ? 'item/started' : 'item/completed', { item });
  notify('turn/plan/updated', { explanation: 'Verify before reporting.', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Validate', status: 'inProgress' }] });
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 540, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true });
  const disclosure = chat.locator('.graphical-turn-process');
  await expect(disclosure).toHaveAttribute('open');
  const groups = chat.locator('.graphical-work-group');
  for (const group of await groups.all()) { await expect(group).not.toHaveAttribute('open'); await group.locator(':scope > summary').click(); }
  const step = id => chat.locator(`[data-chat-item="${id}"]`);
  const command = step('command').locator('.graphical-activity'); await expect(command).not.toHaveAttribute('open'); await command.locator(':scope > summary').click();
  await expect(command.locator('pre').first()).toHaveText(items[3].command); await expect(command.locator('h1,strong')).toHaveCount(0);
  await command.getByRole('button', { name: 'Copy command', exact: true }).click(); assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n','\n'), items[3].command);
  notify('item/commandExecution/outputDelta', { itemId: 'command', delta: '  streamed output\n' });
  await expect(command.locator('pre').last()).toContainText('  streamed output'); await expect(command).toHaveAttribute('open');
  const reader = chat.locator('.graphical-messages');
  await reader.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -150, bubbles: true })); element.scrollTop = 30; });
  await page.waitForTimeout(150); const before = await reader.evaluate(element => element.scrollTop);
  for (let n = 0; n < 3; n++) notify('item/commandExecution/outputDelta', { itemId: 'command', delta: `more output ${n}\n` });
  await page.waitForTimeout(150); assert.ok(Math.abs(await reader.evaluate(element => element.scrollTop) - before) <= 2, 'Streaming respects the reader position');
  const streamingOutput = '  output with <script>inert</script> **literal**\n' + 'x'.repeat(34000);
  notify('item/started', { item: { ...items[3], aggregatedOutput: streamingOutput } });
  await command.getByRole('button', { name: 'Load full output', exact: true }).click(); await expect(command.locator('pre').last()).toHaveText(streamingOutput);
  const long = streamingOutput + '\nfinished';
  notify('item/completed', { item: { ...items[3], aggregatedOutput: long, status: 'completed', exitCode: 0, durationMs: 1234 } });
  await expect(command.locator(':scope > summary')).toContainText('Ran command'); await expect(command).toHaveAttribute('open');
  await expect(command).toContainText('Output preview shortened.');
  await command.getByRole('button', { name: 'Load full output', exact: true }).click(); await expect(command.locator('pre').last()).toHaveText(long);
  await command.getByRole('button', { name: 'Copy output', exact: true }).click(); assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n','\n'),long);
  await command.screenshot({ path: path.join(root, '.cache/codex-steps-command.png') });
  await command.locator(':scope > summary').click();
  for (const id of ['tool','web','open','find','function','future','imagefail']) {
    const detail = step(id).locator('details.graphical-activity'); await detail.locator(':scope > summary').click();
  }
  const tool = step('tool'); await tool.getByText('Arguments', { exact: true }).first().click(); await tool.getByText('Structured result', { exact: true }).click();
  await expect(tool).toContainText('[Redacted]'); await expect(tool).toContainText('Two matches found.');
  await expect(step('web')).toContainText('Version notes'); await expect(step('open').locator('a')).toHaveCount(0); await expect(step('find')).toContainText('version < 2');
  await expect(step('function')).toContainText('Recorded lookup result'); await expect(step('future')).toContainText('A recorded future operation.'); await expect(step('imagefail')).toContainText('usage limit reached');
  const file = step('changes').locator('.graphical-file-change'); await file.locator(':scope > summary').click();
  await expect(file).toContainText('Moved'); await expect(file.locator('.added')).toHaveText(/\+new/); await expect(file.locator('.removed')).toHaveText(/-old/);
  await file.screenshot({ path: path.join(root, '.cache/codex-steps-file.png') }); await tool.screenshot({ path: path.join(root, '.cache/codex-steps-tool.png') });
  for (const width of [320, 390, 540, 1200]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `No overflow at ${width}`); }
  notify('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '## Complete\n\nVerified the **result**.\n\n| Check | Status |\n| --- | --- |\n| Rendering | Passed |' } });
  notify('turn/completed', { turn: { id: 'steps', status: 'completed' } });
  await expect(step('final').getByRole('heading', { name: 'Complete', exact: true })).toBeVisible(); assert.equal(await step('final').locator('xpath=ancestor::details').count(), 0);
  await page.setViewportSize({ width: 540, height: 1000 }); if (await disclosure.evaluate(node => node.open)) await disclosure.locator(':scope > summary').click();
  await chat.screenshot({ path: path.join(root, '.cache/codex-steps-overview.png') });
  assert.doesNotMatch(await chat.textContent(), /NEVER_RENDER_/); assert.equal(runtime.items.size, items.length + 2); assert.ok(!wire.calls.some(call => call.method === 'turn/start'));
  assert.deepEqual(errors, []); console.log('PASS: native semantic mapping, command copy/full output, streamed stable disclosure, safe structured data, web actions, diff, narrow layouts, final separation. Zero inference.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
