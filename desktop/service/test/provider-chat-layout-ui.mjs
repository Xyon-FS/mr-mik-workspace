// Shared Codex/Claude chrome in the production UI; synthetic runtimes only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
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
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-provider-layout-')), nativeEvents = [], claudeWires = [];
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir, native: event => nativeEvents.push(event), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  const profile = await service.profiles.create('Layout fixture');
  service.accountLimitReader.context = async (_agent, profileId) => ({ directory: profileId });
  service.accountLimitReader.codex = async () => ({ windows: [{ label: '5h', percent: 25, resetsAt: null }] });
  service.accountLimitReader.claude = async () => ({ windows: [{ label: '5h', percent: 0, resetsAt: null }] });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const codex = graphicalFixture({ modelCatalogue: [{ model: 'fixture-model', displayName: 'Fixture model', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] });
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const fixture = claudeFixture(options.session.nativeId, { commands: [{ name: 'fixture-context', description: 'Fixture selectable native skill' }, { name: 'compact', builtin: true }], contextUsage: { totalTokens: 12000, maxTokens: 200000 }, usage: { session: { model_usage: { fixture: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }, rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: null, resets_at: null } } } }); claudeWires.push(fixture);
    return new ClaudeChat({ ...options, transportFactory: fixture.factory });
  };
  const chats = [];
  for (const agent of ['codex', 'claude']) chats.push(await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} shared layout`, accountProfileId: agent === 'codex' ? profile.id : undefined }));
  const focus = async id => {
    const response = await fetch(`${service.origin}/api/sessions/${id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.ok(response.ok);
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const geometry = new Map();
  for (const session of chats) {
    await focus(session.id); await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${session.agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    const input = chat.getByRole('textbox', { name: `Message ${session.agent === 'codex' ? 'Codex' : 'Claude'}`, exact: true });
    await expect(chat.getByRole('combobox', { name: 'Model and reasoning', exact: true })).toBeEnabled();
    if (session.agent === 'claude') await expect(chat.getByRole('combobox', { name: 'Model and reasoning', exact: true })).toContainText('Native default model');
    for (const width of [1280, 650, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(chat.locator('.graphical-composer')).toBeVisible();
      assert.ok(await chat.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${session.agent} ${width}: horizontal overflow`);
      if(await page.getByRole('complementary',{name:'Conversations by project'}).isVisible()) await page.getByRole('button',{name:'Collapse project panel',exact:true}).click();
      const bounds = await chat.locator('.graphical-composer').boundingBox();
      if (session.agent === 'codex') geometry.set(width, bounds);
      else { const reference = geometry.get(width); assert.ok(Math.abs(reference.x - bounds.x) <= 1); assert.ok(Math.abs(reference.width - bounds.width) <= 1); }
      await chat.getByRole('combobox', { name: 'Model and reasoning', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Model and reasoning', exact: true }); await expect(picker).toBeVisible();
      if(session.agent==='codex' && width===1280){
        await picker.getByRole('combobox',{name:'Codex account',exact:true}).click(); await page.getByRole('listbox',{name:'Codex account',exact:true}).getByRole('option',{name:'Layout fixture',exact:true}).click();
        await expect(picker).toBeVisible();
      }
      const panel = await picker.boundingBox(); assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= width + 1);
      if (!await picker.getByRole('region',{name:'Account limits',exact:true}).isVisible()) await picker.getByRole('button',{name:'Account usage',exact:true}).click();
      await expect(picker.getByRole('region', { name: 'Account limits', exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
      await chat.getByLabel('Chat details', { exact: true }).click();
      const details = chat.locator('.graphical-details'); await expect(details).toHaveAttribute('open', '');
      await details.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(details.getByRole('region', { name:'Session',exact:true })).toBeVisible(); await details.getByRole('tab',{name:'Context',exact:true}).click(); await expect(details.getByRole('region',{name:'Context',exact:true})).toBeVisible();
      await details.getByRole('tab', { name: 'Session', exact: true }).click(); await expect(details.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
      await expect(details.getByRole('tab', { name: 'Usage', exact: true })).toHaveCount(0);
      await details.getByRole('tab', { name: 'Actions', exact: true }).click(); await expect(details.getByRole('button', { name: 'Rename chat', exact: true })).toBeVisible();
      await details.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(details.getByRole('button', { name: 'Continue in CLI', exact: true })).toHaveCount(0);
      await expect(details.getByText('Token details', { exact: true })).toHaveCount(0);
      assert.deepEqual(await details.getByRole('region', { name: 'Session', exact: true }).locator('dt').allTextContents(), ['Account']);
      if (width === 1280) {
        const response = await fetch(`${service.origin}/api/accounts/limits?agent=${session.agent}${session.agent === 'codex' ? `&profileId=${profile.id}` : ''}`, { headers: { Authorization: `Bearer ${service.token}` } });
        assert.ok(response.ok); assert.equal((await response.json()).windows[0].percent, session.agent === 'codex' ? 25 : 0);
      }
      const detailBounds = await details.locator('.graphical-info-panel').boundingBox(); assert.ok(detailBounds.x >= 0 && detailBounds.x + detailBounds.width <= width + 1);
      await page.keyboard.press('Escape'); await expect(details).not.toHaveAttribute('open', '');
      await chat.getByLabel('Add context', { exact: true }).click();
      if (session.agent === 'claude') { await expect(chat.getByRole('button', { name: 'File or folder reference', exact: true })).toBeVisible(); await expect(chat.getByRole('button', { name: 'Choose a skill', exact: true })).toBeVisible(); }
      await page.keyboard.press('Escape');
      await input.fill('First line\nSecond line\nThird line\nFourth line');
      assert.ok((await input.boundingBox()).height > 70, 'Shared textarea must grow with its draft');
      await input.fill('');
      await page.keyboard.press('Control+f'); await expect(chat.getByRole('textbox', { name: 'Search conversation', exact: true })).toBeVisible();
      await chat.getByRole('button', { name: 'Close conversation search', exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await input.fill('Synthetic layout message'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(chat.getByRole('article', { name: `${session.agent === 'codex' ? 'Codex' : 'Claude'} response`, exact: true })).toHaveCount(1);
    const file = path.join(repo, `${session.agent}-a-long-reference-name-for-layout-verification.txt`); await writeFile(file, 'Synthetic reference');
    const attached = await fetch(`${service.origin}/api/sessions/${session.id}/attach`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [file], runtimeId: service.sessions.get(session.id).graphical.runtimeId }) }); assert.ok(attached.ok, await attached.text());
    await expect(chat.getByLabel('Draft attachments').getByRole('button', { name: `Remove ${path.basename(file)}`, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, `.cache/${session.agent}-shared-layout-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, `.cache/${session.agent}-shared-layout-narrow.png`) });
    await chat.getByLabel('Draft attachments').getByRole('button', { name: `Remove ${path.basename(file)}`, exact: true }).click();
    await expect(chat.getByLabel('Draft attachments').getByRole('button')).toHaveCount(0);
    if (session.agent === 'claude') {
      await page.setViewportSize({ width: 1280, height: 900 });
      await chat.getByRole('article', { name: 'Claude response', exact: true }).getByRole('button', { name: 'Quote message', exact: true }).click();
      await expect(chat.getByLabel('Prompt context')).toContainText('Synthetic Claude answer.');
      await chat.getByLabel('Prompt context').locator('summary').click();
      await chat.getByRole('button', { name: 'View source', exact: true }).click();
      await expect(chat.locator('[data-search-target]')).toContainText('Synthetic Claude answer.');
      await chat.getByLabel('Add context', { exact: true }).click();
      await chat.getByRole('button', { name: 'Choose a skill', exact: true }).click();
      await chat.getByRole('button', { name: 'fixture-context Fixture selectable native skill', exact: true }).click();
      await expect(input).toHaveValue('$fixture-context ');
      await expect(chat.getByRole('button', { name: 'Remove skill fixture-context', exact: true })).toHaveCount(0);
      await chat.getByRole('combobox', { name: 'Model and reasoning', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Model and reasoning', exact: true }).getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      assert.equal(claudeWires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 1);
      const image = path.join(repo, 'context-image.png'); await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
      await service.sessions.get(session.id).graphical.attach([image]);
      await chat.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(chat.getByText('native skill commands combined with images', { exact: false })).toBeVisible();
      await expect(input).toHaveValue('$fixture-context ');
      assert.equal(claudeWires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 1);
      await chat.getByRole('button', { name: 'Remove context-image.png', exact: true }).click();

      await input.fill('$fixture-context Review selected context');
      await service.sessions.persist();
      assert.equal(service.sessions.get(session.id).graphical.composer.items.length, 1);
      await page.screenshot({ path: path.join(root, '.cache/claude-explicit-context-ui.png') });
      await chat.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(chat.getByLabel('Prompt context')).toHaveCount(0);
      const sent = claudeWires.flatMap(wire => wire.calls).filter(call => call.type === 'user');
      assert.match(sent[1].message.content[0].text, /^\/fixture-context Review selected context/); assert.match(sent[1].message.content[0].text, /> Synthetic Claude answer/);
      await chat.getByRole('button', { name: 'Back to latest', exact: true }).click();
      await expect(chat.locator('.chat-skill-mention')).toHaveText('$fixture-context');
      await input.fill('Preserved usage draft');
      await chat.getByLabel('Chat details', { exact: true }).click();
      const usage = chat.getByRole('region', { name: 'Context', exact: true });
      const limits = page.getByRole('dialog', { name: 'Model and reasoning', exact: true }).getByRole('region', { name: 'Account limits', exact: true });
      await chat.getByRole('tab',{name:'Context',exact:true}).click();
      await expect(usage.getByRole('button', { name: 'Compact conversation', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await chat.getByRole('combobox', { name: 'Model and reasoning', exact: true }).click(); if(!await limits.isVisible()) await page.getByRole('button',{name:'Account usage',exact:true}).click(); await limits.getByRole('button', { name: 'Refresh account usage', exact: true }).click();
      await expect(limits).toContainText('0% used'); await page.keyboard.press('Escape'); await chat.getByLabel('Chat details', { exact: true }).click(); await chat.getByRole('tab', { name: 'Context', exact: true }).click(); await expect(usage).toContainText(/12[.,]000 \/ 200[.,]000 tokens/);
      await expect(input).toHaveValue('Preserved usage draft');
      assert.equal(claudeWires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 2);
      await input.fill(''); await expect.poll(() => service.sessions.get(session.id).graphical.draft).toBe('');
      await usage.getByRole('button', { name: 'Compact conversation', exact: true }).click();
      await usage.getByRole('button', { name: 'Confirm compaction', exact: true }).click();
      await expect(usage).toContainText('Compaction: completed');
      assert.equal(service.sessions.get(session.id).nativeId, session.nativeId);
      await page.screenshot({ path: path.join(root, '.cache/claude-native-controls-ui.png') });
    }

  }
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(claudeWires.flatMap(fixture => fixture.calls).filter(call => call.type === 'user').length, 3);
  assert.deepEqual(errors, []);
  console.log('PASS shared Codex/Claude UI: common composer geometry, 1280/650/390px layouts, model/details/context menus, Escape/Ctrl+F, growing drafts, send and attachment chips. Synthetic runtimes only.');
} finally {
  await browser?.close(); await service?.close(); for (const fixture of claudeWires) fixture.close(); await cleanupFixtures();
}
