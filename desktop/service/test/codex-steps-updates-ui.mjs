// Round-three checks: authoritative replacements versus partial display updates.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-step-updates-')), survey = process.argv.includes('--survey');
let browser, service;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic updates'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: wire.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo });
  const runtime = service.sessions.get(session.id).graphical;
  wire.history.set('synthetic-child', []);
  const notify = (method, params) => runtime.message({ method, params: { threadId: runtime.threadId, turnId: 'updates', ...params } });
  notify('turn/started', { turn: { id: 'updates', status: 'inProgress' } });
  const key = 'long-path-component-'.repeat(12);
  for (const item of [
    { id: 'question', type: 'userMessage', text: 'Review updated tool results' },
    { id: 'replace', type: 'mcpToolCall', tool: 'replace', result: { content: [{ type: 'resource', resource: { name: 'Old report', text: 'Old resource', mimeType: 'text/plain' } }] } },
    { id: 'structured', type: 'mcpToolCall', tool: 'replace-structure', result: { content: [], structuredContent: { obsolete: true } } },
    { id: 'clear', type: 'mcpToolCall', tool: 'clear-result', result: { content: [{ type: 'resource', resource: { name: 'Removed report', text: 'Obsolete resource' } }] } },
    { id: 'function', type: 'functionCallOutput', name: 'lookup', output: 'Recorded function output' },
    { id: 'dynamic', type: 'dynamicToolCall', namespace: 'workspace', tool: 'lookup', contentItems: [{ type: 'text', text: 'Dynamic result' }] },
    { id: 'review', type: 'exitedReviewMode', review: JSON.stringify({ findings: [{ title: '[P2] Review the input', body: 'Validate the supplied value.', priority: 2 }] }) },
    { id: 'future', type: 'futureNativeItem', text: 'First line\n  indented second line' },
    { id: 'keys', type: 'mcpToolCall', tool: 'paths', result: { content: [], structuredContent: { [key + 'first']: 'First value', [key + 'second']: 'Second value' } } },
    { id: 'future-note', type: 'futureNativeItem', description: 'Old progress description' },
    { id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['synthetic-child'], agentsStates: { 'synthetic-child': { status: 'running', message: 'Recorded child progress' } } },
    { id: 'final', type: 'agentMessage', phase: 'commentary', text: 'Reviewing the result.' },
  ]) notify('item/completed', { item });
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  browser = await chromium.launch({ headless: true, channel: 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 510, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true });
  if (!await chat.locator('.graphical-turn-process').evaluate(node => node.open)) await chat.locator('.graphical-turn-process > summary').click(); await chat.locator('.graphical-work-group > summary').click();
  const row = id => chat.locator(`[data-chat-item="${id}"]`);
  for (const id of ['structured', 'function', 'dynamic', 'future', 'keys', 'future-note']) await row(id).locator('details.graphical-activity > summary').click();
  await row('keys').getByText('Structured result', { exact: true }).click();
  notify('item/completed', { item: { id: 'replace', type: 'mcpToolCall', tool: 'replace', status: 'completed', result: { content: [{ type: 'text', text: 'Current textual result' }] } } });
  notify('item/completed', { item: { id: 'structured', type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'text', text: 'Current plain result' }], structuredContent: null } } });
  notify('item/completed', { item: { id: 'clear', type: 'mcpToolCall', status: 'failed', result: null, error: { message: 'Result unavailable' } } });
  runtime.upsert({ id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup', status: 'completed' }, { turnId: 'updates' });
  runtime.upsert({ id: 'future-note', type: 'futureNativeItem', description: 'Current progress description' }, { turnId: 'updates' });
  // Defensive partial application projection; not a claim that Codex omits a
  // required output field from its completed native schema.
  runtime.upsert({ id: 'function', type: 'functionCallOutput', status: 'completed' }, { turnId: 'updates' }); runtime.changed();
  await expect(row('structured')).toContainText('Current plain result');
  const checks = [], check = (name, passed) => checks.push({ name, passed });
  check('resource replacement shows current text', await row('replace').getByText('Current textual result', { exact: true }).isVisible());
  check('authoritative plain result clears obsolete structure', await row('structured').getByText('Structured result', { exact: true }).count() === 0);
  check('explicit null result removes the previous resource', await row('clear').getByRole('region', { name: 'Tool result: Removed report', exact: true }).count() === 0);
  check('partial function update keeps recorded output', await row('function').getByText('Recorded function output', { exact: true }).isVisible());
  check('dynamic tool namespace remains visible', (await row('dynamic').locator(':scope .graphical-activity > summary').textContent()).includes('workspace'));
  check('findings-only review is summarized instead of raw JSON', !await row('review').innerText().then(text => text.includes('"findings"')));
  check('unknown multiline text preserves indentation', await row('future').locator('pre').count() === 1 && await row('future').locator('pre').innerText() === 'First line\n  indented second line');
  const text = await row('keys').locator('pre').innerText();
  check('abbreviated object keys keep distinct values', text.includes('First value') && text.includes('Second value'));
  check('fallback public descriptions update without stale notes', await row('future-note').getByText('Current progress description', { exact: true }).isVisible() && !await row('future-note').getByText('Old progress description', { exact: true }).isVisible());
  await row('collab').getByRole('button', { name: 'View agent', exact: true }).click();
  const reader = page.getByRole('dialog', { name: 'Agent conversation', exact: true }); await expect(reader).toBeVisible();
  runtime.upsert({ id: 'collab', type: 'collabAgentToolCall', status: 'completed', prompt: 'Updated agent operation' }, { turnId: 'updates' }); runtime.changed();
  await expect(row('collab')).toContainText('Updated agent operation');
  check('partial agent activity update retains the open reader', await reader.isVisible());
  if (await reader.isVisible()) await reader.getByRole('button', { name: 'Close agent', exact: true }).click();
  check('removed resources are cleared from the result reader', runtime.resultAssets.get('clear')?.length === 0);
  notify('item/completed', { item: { id: 'final', type: 'agentMessage', phase: null, text: 'Review finished.' } });
  notify('turn/completed', { turn: { id: 'updates', status: 'completed' } });
  await expect(row('final')).toContainText('Review finished.');
  check('explicit null phase can become the final unphased response', await row('final').locator('xpath=ancestor::details[contains(@class,"graphical-turn-process")]').count() === 0);
  for (const width of [320, 390, 510, 1100]) { await page.setViewportSize({ width, height: 1000 }); check(`layout ${width}`, await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1)); }
  check('no browser errors', errors.length === 0);
  const evidence = path.resolve('.cache', survey ? 'codex-steps-round3-survey' : 'codex-steps-round3-after'); await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 510, height: 1000 });
  if (!await chat.locator('.graphical-turn-process').evaluate(node => node.open)) await chat.locator('.graphical-turn-process > summary').click();
  for (const id of ['replace', 'review', 'future', 'keys', 'dynamic']) await row(id).screenshot({ path: path.join(evidence, `${id}.png`) });
  await writeFile(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks));
  if (!survey) assert.ok(checks.every(check => check.passed));
  assert.ok(!wire.calls.some(call => call.method === 'turn/start'));
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
