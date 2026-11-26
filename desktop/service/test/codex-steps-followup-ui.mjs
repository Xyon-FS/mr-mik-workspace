// Follow-up acceptance against the compiled UI and real native projection.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';

const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-steps-followup-'));
const survey = process.argv.includes('--survey'), checks = [];
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic follow-up'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: wire.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo });
  const runtime = service.sessions.get(session.id).graphical;
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, turnId: 'followup', ...params } });
  notify('turn/started', { turn: { id: 'followup', status: 'inProgress' } });
  const resource = { content: [{ type: 'resource', resource: { name: 'Report', uri: 'tool://report', mimeType: 'text/plain', text: 'New report content' } }] };
  const exact = 'x'.repeat(32000), long = 'Readable tool output\n' + 'x'.repeat(34000);
  const items = [
    { id: 'question', type: 'userMessage', text: 'Follow-up rendering review' },
    { id: 'open-tool', type: 'mcpToolCall', server: 'fixture', tool: 'report', status: 'inProgress', arguments: { section: 'summary' } },
    { id: 'closed-tool', type: 'mcpToolCall', server: 'fixture', tool: 'report', status: 'inProgress' },
    { id: 'command', type: 'commandExecution', command: 'printf test', aggregatedOutput: 'first output', status: 'inProgress' },
    { id: 'patch', type: 'fileChange', status: 'completed', changes: [{ path: path.join(repo, 'source.txt'), kind: { type: 'update' }, diff: '--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n--- old text\n+++ new text' }] },
    { id: 'large-tool', type: 'mcpToolCall', server: 'fixture', tool: 'large', status: 'completed', result: { content: [{ type: 'text', text: long }], structuredContent: { count: 1, token: 'DO_NOT_DISPLAY_RAW_SECRET' } } },
    { id: 'exact-tool', type: 'mcpToolCall', server: 'fixture', tool: 'exact', status: 'completed', result: { content: [{ type: 'text', text: exact }], structuredContent: { count: 1 } } },
    { id: 'structured-tool', type: 'mcpToolCall', tool: 'inspect', status: 'completed', result: { content: [], structuredContent: Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`field${n}`, 'x'.repeat(1000)])) } },
  ];
  for (const item of items) notify(item.status === 'inProgress' ? 'item/started' : 'item/completed', { item });
  notify('turn/diff/updated', { diff: '--- a/aggregate.txt\n+++ b/aggregate.txt\n@@ -1 +1 @@\n-old aggregate\n+new aggregate' });
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  browser = await chromium.launch({ headless: true, channel: 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 530, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true });
  if (!await chat.locator('.graphical-turn-process').evaluate(node => node.open)) await chat.locator('.graphical-turn-process > summary').click();
  await chat.locator('.graphical-work-group > summary').click();
  const item = id => chat.locator(`[data-chat-item="${id}"]`);
  const open = item('open-tool'); await open.locator('details.graphical-activity > summary').click(); await open.getByText('Arguments', { exact: true }).first().click();
  const initial = await open.locator('[data-step-type]').elementHandle();
  for (const id of ['open-tool', 'closed-tool']) notify('item/completed', { item: { id, type: 'mcpToolCall', status: 'completed', result: resource } });
  await expect(open).toContainText('New report content');
  const check = (name, passed) => { checks.push({ name, passed }); };
  check('same tool DOM shell when resources arrive', await initial.evaluate(node => node.isConnected));
  check('open arguments survive resource completion', await open.locator('.graphical-step-inspect').first().evaluate(node => node.open));
  check('closed tool stays closed when resources arrive', !await item('closed-tool').getByText('New report content', { exact: true }).isVisible());
  const command = item('command'); await command.locator('details.graphical-activity > summary').click();
  const copy = command.getByRole('button', { name: 'Copy output', exact: true }); await copy.click(); await expect(copy).toHaveText('Copied');
  notify('item/commandExecution/outputDelta', { itemId: 'command', delta: '\nnew output' }); await expect(command.locator('pre').last()).toContainText('new output');
  check('copy feedback resets when output changes', await copy.textContent() === 'Copy');
  const patch = item('patch'); await patch.locator('.graphical-file-change > summary').click();
  check('triple plus/minus inside a hunk are edits', await patch.locator('.added').filter({ hasText: '+++ new text' }).count() === 1 && await patch.locator('.removed').filter({ hasText: '--- old text' }).count() === 1);
  const aggregate = item('diff-followup'); await aggregate.locator('details.graphical-activity > summary').click();
  check('aggregate diff uses the same edit colors', await aggregate.locator('.added').evaluate(node => getComputedStyle(node).color !== getComputedStyle(node.closest('code')).color));
  check('copy controls have a usable pointer target', await copy.evaluate(node => node.getBoundingClientRect().height >= 24));
  const large = item('large-tool'); await large.locator('details.graphical-activity > summary').click();
  await page.route(url => url.pathname.endsWith('/chatoutput') && url.searchParams.get('item') === 'large-tool', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic temporary output error' }) }), { times: 1 });
  await large.getByRole('button', { name: 'Load full output', exact: true }).click(); await expect(large.getByRole('alert')).toContainText('Synthetic temporary output error');
  await large.getByRole('button', { name: 'Load full output', exact: true }).click(); await expect(large).toContainText('Recorded output snapshot loaded.');
  check('successful output retry clears the previous error', await large.getByRole('alert').count() === 0);
  check('full tool text excludes raw structured suffix', !((await large.textContent()).includes('DO_NOT_DISPLAY_RAW_SECRET')));
  const exactTool = item('exact-tool'); await exactTool.locator('details.graphical-activity > summary').click();
  check('exact preview boundary is not marked shortened', await exactTool.getByRole('button', { name: 'Load full output', exact: true }).count() === 0);
  const structure = item('structured-tool'); await structure.locator('details.graphical-activity > summary').click(); await structure.getByText('Structured result', { exact: true }).click();
  let validStructure = true; try { JSON.parse(await structure.locator('pre').innerText()); } catch { validStructure = false; }
  check('shortened structured data is valid JSON with a visible notice', validStructure && await structure.getByText('Structured preview shortened.', { exact: true }).isVisible());
  check('resource cards do not repeat their generated summary as output', await open.getByRole('button', { name: 'Copy output', exact: true }).count() === 0);
  const widths = [];
  for (const width of [320, 390, 530, 1100]) { await page.setViewportSize({ width, height: 1000 }); widths.push(await chat.evaluate(node => node.scrollWidth <= node.clientWidth + 1)); }
  check('no horizontal chat overflow', widths.every(Boolean)); check('no browser errors', errors.length === 0);
  const evidence = path.join(root, '.cache', survey ? 'codex-steps-followup-survey' : 'codex-steps-followup-after');
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 530, height: 1000 });
  for (const [name, locator] of [['tool', open], ['patch', patch], ['command', command], ['aggregate', aggregate], ['structured', structure]]) await locator.screenshot({ path: path.join(evidence, `${name}.png`) });
  await writeFile(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
  if (!survey) assert.ok(checks.every(entry => entry.passed), 'Follow-up acceptance checks must all pass');
  assert.ok(!wire.calls.some(call => call.method === 'turn/start'));
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
