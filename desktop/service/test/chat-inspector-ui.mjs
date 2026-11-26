import { testBrowserEnvironment } from './fixtures.mjs';
// Production chat + Workspace inspector; synthetic native events, no inference.
import assert from 'node:assert/strict';
import { revealProcessFor } from './chat-disclosure-ui.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-inspector-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), native = path.join(home, '.codex');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(path.join(repo, 'src')); await mkdir(native, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(native, 'config.toml'), '# Synthetic\n');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: native } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Inspector fixture'); service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const nativeFixture = graphicalFixture(); service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: nativeFixture.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', chatInterface: 'chat', accountProfileId: profile.id, cwd: repo, codexPermissions: 'ask' }), runtime = service.sessions.get(session.id).graphical;
  const file = path.join(repo, 'src', 'counter.ts'), original = '// Counter\nexport const count = 2;\nexport const next = count + 1;\n' + Array.from({ length: 300 }, (_, index) => `// Fixture line ${index + 4}`).join('\n'); await writeFile(file, original);
  runtime.upsert({ id: 'change-result', type: 'fileChange', status: 'completed', changes: [{ path: file, kind: { type: 'update' }, diff: '--- a/src/counter.ts\n+++ b/src/counter.ts\n@@ -1,3 +1,3 @@\n // Counter\n-export const count = 1;\n+export const count = 2;\n export const next = count + 1;' }, { path: path.join('src', 'counter.ts'), kind: 'update', diff: '@@ -3 +3 @@\n-export const next = count;\n+export const next = count + 1;' }, { path: path.join(repo, 'removed.ts'), kind: { type: 'delete' }, diff: '@@ -1 +0,0 @@\n-removed' }, { path: path.join(repo, 'binary.bin'), kind: 'update', diff: 'Binary files a/binary.bin and b/binary.bin differ' }] });
  runtime.upsert({ id: 'review-result', type: 'exitedReviewMode', review: JSON.stringify({ overall_explanation: 'One recorded finding to inspect.', findings: [{ title: '[P1] Check the increment', body: 'Inspect the recorded location before changing this code.', priority: 1, code_location: { absolute_file_path: file, line_range: { start: 3, end: 3 } } }] }) });
  browser = await chromium.launch({ env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'msedge', headless: true }); const context = await browser.newContext(); const chatPage = await context.newPage(), workspace = await context.newPage();
  const errors = []; for (const page of [chatPage, workspace]) page.on('pageerror', error => errors.push(error.message));
  await workspace.goto(service.urls.workspace); await chatPage.goto(service.urls.chats);
  const chat = chatPage.getByRole('region', { name: 'Codex graphical chat', exact: true }), draft = chat.getByRole('textbox', { name: 'Message Codex', exact: true });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  await draft.fill('Preserve this unsent draft');
  const opened = await fetch(`${service.origin}/api/sessions/${session.id}/chat`, { method:'POST', headers, body:JSON.stringify({action:'open-file', href:file}) });
  assert.ok(opened.ok, await opened.clone().text());
  await workspace.getByRole('button', { name:'Pin counter.ts', exact:true }).click();
  await revealProcessFor(chat.locator('details.graphical-work-group').first()); await chat.locator('details.graphical-work-group > summary').first().click();
  await chat.getByRole('button', { name: 'View changes', exact: true }).click();
  const panel = workspace.getByRole('region', { name: 'Changes inspector', exact: true }); await expect(panel).toBeVisible();
  await expect(workspace.getByRole('tab', { name:'Changes', exact:true })).toHaveAttribute('aria-selected','true');
  await expect(panel.locator('.inspector-file')).toHaveCount(3);
  await expect(panel.getByRole('button', { name:'Quote in chat', exact:true })).toHaveCount(0);
  await expect(panel.locator('.inspector-diff-row.add')).toContainText('export const count = 2;'); await expect(panel.locator('.inspector-diff-row.remove')).toContainText('export const count = 1;');
  const addedRow = panel.getByRole('button',{name:/Diff row 6, new line 2: /});
  await addedRow.click();
  await workspace.keyboard.press('Shift+ArrowUp');
  await expect(panel.locator('.inspector-selection')).toContainText('Rows 5');
  await workspace.keyboard.press('Shift+ArrowDown');
  await expect(panel.locator('.inspector-selection')).toContainText('Row 6 selected');
  await expect(panel.locator('.inspector-select-row[tabindex="0"]')).toHaveCount(1);
  await workspace.keyboard.press('Shift+ArrowUp');
  await panel.getByRole('button',{name:'Quote in chat',exact:true}).click();
  await expect(panel).toContainText('Added to prompt context');
  await expect(chat.getByLabel('Prompt context')).toContainText('Recorded diff:');
  await expect(draft).toHaveValue('Preserve this unsent draft');
  await addedRow.press('Enter');
  await expect(panel.locator('[data-current-line="true"]')).toContainText('export const count = 2;'); await expect(panel.locator('[data-current-line="true"]')).toBeFocused();
  await panel.getByLabel('Changes options', {exact:true}).click();
  await panel.getByRole('button', {name:/Go to line/}).click();
  await panel.getByRole('spinbutton',{name:'Line',exact:true}).fill('240');
  await panel.getByRole('button',{name:'Go to line',exact:true}).click();
  await expect(panel.locator('[data-current-line="true"]')).toContainText('Fixture line 240');
  const reader = panel.locator('.inspector-body');
  await reader.evaluate(element => { element.scrollTop = 100 });
  await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(100);
  await panel.getByLabel('Changes options',{exact:true}).click();
  await panel.getByRole('button',{name:'Refresh recorded result',exact:true}).click();
  await expect(panel.locator('[data-current-line="true"]')).toContainText('Fixture line 240');
  await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(100);
  await panel.getByRole('button', { name: 'Recorded diff', exact: true }).click();
  await writeFile(file, original.replace('Fixture line 240', 'Updated line 240'));
  let resume;
  const gate = new Promise(resolve => { resume = resolve });
  await workspace.route(`**/api/inspector/${session.id}`, async route => { await gate; await route.continue() }, { times: 1 });
  try {
    await panel.getByRole('button', { name: 'Current file', exact: true }).click();
    await expect(reader.getByRole('status')).toContainText('Reading current file');
    await expect(panel.locator('[data-current-line="true"]')).toHaveCount(0);
  } finally { resume(); }
  await expect(panel.locator('[data-current-line="true"]')).toContainText('Updated line 240');
  await writeFile(file, original);
  await panel.getByRole('button', { name: 'Recorded diff', exact: true }).click();
  await panel.getByRole('combobox',{name:'Recorded patch'}).selectOption({label:'2 / 2'});
  await expect(panel.locator('.inspector-diff-row.add')).toContainText('export const next = count + 1;');
  await panel.getByRole('button', { name: /removed\.ts/ }).click(); await panel.getByRole('button', { name: 'Current file', exact: true }).click(); await expect(panel.getByRole('status')).toContainText('missing or was deleted');
  await panel.getByRole('button', { name: /binary\.bin/ }).click(); await expect(panel.getByLabel('Recorded diff', { exact: true })).toContainText('Binary change');
  await workspace.getByRole('button', { name: 'Close view Changes', exact: true }).click(); await expect(panel).toHaveCount(0);
  await chat.locator('.graphical-review-findings > summary').click(); await expect(chat.getByText('[P1] Check the increment', {exact:true})).toBeVisible();
  // The intermediate UI intentionally has no Workspace export/inspector button.
  // Keep endpoint/Workspace inspection regression coverage separately from the
  // new inline finding navigation checked above.
  await fetch(`${service.origin}/api/inspector/${session.id}`, { method: 'POST', headers, body: JSON.stringify({action:'show',itemId:'review-result'}) });
  await expect(panel.locator('.inspector-body')).toHaveAttribute('aria-label','Current file preview');
  await expect(panel.locator('[data-current-line="true"]')).toContainText('next = count + 1');
  await panel.getByText('Findings',{exact:false}).filter({hasText:/^Findings 1$/}).click();
  await panel.getByRole('button', { name: /Check the increment/ }).click(); await expect(panel.locator('[data-current-line="true"]')).toContainText('next = count + 1');
  await panel.getByLabel('Changes options', { exact:true }).focus(); await workspace.keyboard.press('Tab');
  await expect(reader).toBeFocused();
  assert.ok(await reader.evaluate(el=>el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid' && parseFloat(getComputedStyle(el).outlineWidth) >= 2), 'Keyboard scroll region has a visible focus indicator');
  const evidence = process.argv.indexOf('--evidence'); if (evidence !== -1) await panel.screenshot({ path: path.resolve(process.argv[evidence + 1]) });
  await workspace.setViewportSize({ width: 320, height: 820 }); await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(panel.getByRole('combobox',{name:'Changed file'})).toBeVisible();
  await expect(panel.locator('.inspector-sidebar')).toBeHidden();
  assert.equal((await fetch(`${service.origin}/api/inspector/${session.id}?itemId=review-result`)).status, 401);
  // A result modified after inspection cannot use the old file reference/version.
  const result = await (await fetch(`${service.origin}/api/inspector/${session.id}?itemId=review-result`, { headers })).json(); runtime.items.get('review-result').text += '\nUpdated';
  const stale = await fetch(`${service.origin}/api/inspector/${session.id}`, { method: 'POST', headers, body: JSON.stringify({ action: 'file', itemId: 'review-result', version: result.version, fileId: result.files[0].id, line: 3 }) }); assert.ok(!stale.ok); assert.match((await stale.json()).error, /changed/);
  await expect(draft).toHaveValue('Preserve this unsent draft'); assert.equal(await readFile(file, 'utf8'), original);
  assert.ok(!nativeFixture.calls.some(call => ['turn/start', 'turn/steer', 'review/start'].includes(call.method))); assert.deepEqual(errors, []);
  console.log('PASS: recorded diffs, current-line navigation, review findings, missing/binary files, stale-version/auth boundaries, narrow layout and unsent draft retained; no native inference or source writes.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
