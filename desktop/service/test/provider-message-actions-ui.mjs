// Production UI/service acceptance. Real OpenCode TUI, local mock provider;
// Claude transport is synthetic with official SDK fork/history helpers.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const { OpenCodePicker } = await import(pathToFileURL(path.join(serviceRoot, 'opencode-picker.mjs')));
const original = { ...process.env }, base = await mkdtemp(path.join(os.tmpdir(), 'mik-provider-actions-ui-'));
let service, browser, mock, calls = 0;
const nativeLifecycle = [];
const phase = process.argv.includes('--v1-only') ? [1] : process.argv.includes('--v2-only') ? [2] : process.argv.includes('--claude-only') ? [0] : [0, 1, 2];
try {
  browser = await chromium.launch({ headless: true, env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'chrome' });
  for (const family of phase) {
    calls = 0;
    const folder = path.join(base, `provider-${family}`), repo = path.join(folder, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
    for (const key of Object.keys(process.env)) if (!/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|MRMAK_TEST_BROWSER)$/i.test(key)) delete process.env[key];
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']) { process.env[key] = path.join(folder, key); await mkdir(process.env[key]); }
    process.env.DISABLE_AUTOUPDATER = '1'; process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true'; process.env.OPENCODE_DISABLE_AUTOUPDATE = 'true';
    if (family) {
      const skillFolder = path.join(repo, '.opencode', 'skills', 'fixture-context'); await mkdir(skillFolder, { recursive: true }); await writeFile(path.join(skillFolder, 'SKILL.md'), '---\nname: fixture-context\ndescription: Synthetic selectable context\n---\nSynthetic skill instructions. No tool calls.\n');
      process.env.MRMIK_OPENCODE_BINARY = path.join(root, family === 1 ? '.cache/opencode-v1-phase0/node_modules/opencode-windows-x64/bin/opencode.exe' : '.cache/opencode-v2/node_modules/@opencode/cli-windows-x64/bin/opencode.exe');
      mock = http.createServer(async (request, response) => {
        for await (const _ of request) { /* No prompt logging. */ } calls++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.end(chunk({ role: 'assistant', content: process.argv.includes('--controls-only') && calls > 1 ? '## Objective\n- Continue the synthetic fixture.\n\n## Requirements\n- Use synthetic data only.\n\n## Decisions\n- Keep native identity.\n\n## Work State\n### Completed\n- Local fixture verified.\n### Active\n- Native controls check.\n### Blocked\n- (none)\n\n## Next Move\n1. Continue the fixture.\n\n## Relevant Files\n(none)\n\n## Important Context\n- No real provider used.' : 'Local phase-one answer.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      });
      await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ snapshots: false, model: 'fixture/test', enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Offline fixture', options: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { test: { name: 'Phase One', limit: { context: 200000, output: 256 } } } } } });
    }
    service = await createService({ repo, uiDir, mcpOptions: { home: process.env.HOME, env: process.env }, profileOptions: { root: path.join(folder, 'accounts'), claudeIdentity: async () => ({ status: 'logged-in', identity: 'provider-message-actions-ui-fixture' }) } }, factory);
    service.sessions.on('session', session => { nativeLifecycle.push({ id: session.id, nativeId: session.nativeId, status: session.status, hasConversation: session.hasConversation, toolRefresh: session.toolRefresh }); if (nativeLifecycle.length > 60) nativeLifecycle.shift(); });
    // Synthetic Claude does not discover native tools. Real OpenCode must keep
    // its actual launch fingerprint: a fabricated empty baseline makes the
    // refresh scheduler detect changes and restart the terminal mid-scenario.
    if (!family) service.sessions.captureTools = async () => ({});
    if (!family) service.sessions.createGraphicalRuntime = options => {
      const fixture = claudeFixture(options.session.nativeId, { effort: options.session.effort, mode: options.session.claudePermissionMode });
      let runtime;
      const wrapped = input => {
        const wire = fixture.factory(input), send = wire.send.bind(wire);
        wire.send = line => {
          send(line);
          if (JSON.parse(line).type !== 'user') return;
          calls++;
          const messages = runtime.protocol.state.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type));
          const directory = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, `${runtime.session.nativeId}.jsonl`), messages.map((item, index) => JSON.stringify({ type: item.type === 'userMessage' ? 'user' : 'assistant', uuid: item.nativeUuid || item.id, parentUuid: index ? messages[index - 1].nativeUuid || messages[index - 1].id : null, sessionId: runtime.session.nativeId, cwd: repo, isSidechain: false, timestamp: new Date(index + 1).toISOString(), message: { role: item.type === 'userMessage' ? 'user' : 'assistant', ...(item.type === 'agentMessage' ? { id: item.id.slice(0, item.id.lastIndexOf(':')), stop_reason: 'end_turn' } : {}), content: [{ type: 'text', text: item.text }] } })).join('\n') + '\n');
        }; return wire;
      };
      runtime = new ClaudeChat({ ...options, transportFactory: wrapped }); return runtime;
    };
    const source = await service.sessions.create({ agent: family ? 'opencode' : 'claude', chatInterface: family ? 'cli' : 'chat', cwd: repo, effort: family ? undefined : 'low', name: `Phase-one source ${family}` });
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const post = async (route, body = {}) => { const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers, body: JSON.stringify(body) }); const result = await response.json(); assert.ok(response.ok, result.error); return result; };
    await post(`/sessions/${source.id}/focus`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => { if (!response.url().endsWith('/messageaction')) return; const value = await response.json(); if (!response.ok()) console.log('Isolated action error:', value.error); else if (value.notice) { const request = response.request().postDataJSON(), id = response.url().match(/sessions\/([^/]+)\/messageaction/)[1]; const receipt = JSON.parse(await readFile(path.join(service.sessions.stateDir, `message-action-${id}-${request.requestId}.json`), 'utf8')); console.log('Isolated restoration error:', receipt.restoreStep, receipt.reason); } });
    await page.goto(service.urls.chats);
    if (process.argv.includes('--context-only') || process.argv.includes('--controls-only')) {
      assert.ok(family, 'Choose an OpenCode family for this native context check');
      const native = service.sessions.get(source.id);
      await expect.poll(async () => { try { return Array.isArray((await new OpenCodePicker(service.sessions).command(source.id, 'catalog')).models); } catch { return false; } }, { timeout: 45000 }).toBe(true);
      await expect.poll(async () => { try { return await service.sessions.permissionReady(native); } catch { return false; } }, { timeout: 30000 }).toBe(true);
      if (process.argv.includes('--controls-only')) {
        const picker = new OpenCodePicker(service.sessions);
        service.sessions.input(source.id, 'Synthetic controls fixture', { coordinator: true, submit: false });
        await page.waitForTimeout(500); await post(`/sessions/${source.id}/control`, { action: 'submit' });
        await expect.poll(() => native.completionVersion, { timeout: 30000 }).toBeGreaterThan(0);
        await expect.poll(() => native.activity).toBe('idle');
        await page.waitForTimeout(1000);
        await post(`/sessions/${source.id}/focus`);
        const initialId = native.nativeId;
        await page.getByRole('button', { name: 'Message actions', exact: true }).click();
        await page.getByRole('button', { name: 'Inspect native usage and modes', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Choose native agent / Plan', exact: true })).toBeEnabled({ timeout: 15000 });
        await page.getByRole('button', { name: 'Choose native agent / Plan', exact: true }).click();
        await expect.poll(async () => (await service.sessions.read(source.id, 120)).screen, { timeout: 15000 }).toMatch(/(?:Switch agent|Select agent|\bAgents\b)/);
        await page.waitForTimeout(500);
        await writeFile(path.join(root, `.cache/opencode-v${family}-agent-selector.txt`), (await service.sessions.read(source.id, 90)).screen);
        const beforeMode = calls; service.sessions.input(source.id, '\x1b[B'); await page.waitForTimeout(400); service.sessions.input(source.id, '\r');
        await expect.poll(async () => (await service.sessions.read(source.id, 120)).screen, { timeout: 10000 }).toMatch(/Plan/);
        assert.equal(calls, beforeMode);
        await page.waitForTimeout(2700);
        await expect.poll(async () => { try { return await service.sessions.permissionReady(native); } catch { return false; } }, { timeout: 15000 }).toBe(true);
        service.sessions.input(source.id, 'Synthetic Plan-mode fixture', { coordinator: true, submit: false }); await page.waitForTimeout(500); await post(`/sessions/${source.id}/control`, { action: 'submit' });
        await expect.poll(() => native.completionVersion, { timeout: 30000 }).toBeGreaterThan(1); await expect.poll(() => native.activity).toBe('idle'); await post(`/sessions/${source.id}/focus`);
        await page.getByRole('button', { name: 'Message actions', exact: true }).click();
        await page.getByRole('button', { name: 'Inspect native usage and modes', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Choose native agent / Plan', exact: true })).toBeEnabled({ timeout: 15000 });
        const state = await post(`/sessions/${source.id}/nativecontrols`, { action: 'inspect', launchId: native.openCodeLaunchId });
        assert.equal(state.usage.agent, 'plan'); assert.equal(state.usage.model.modelID, 'test'); assert.equal(state.usage.tokens.input, 0);
        service.sessions.input(source.id, 'KEEP_NATIVE_DRAFT', { coordinator: true, submit: false }); await page.waitForTimeout(400);
        const refused = await fetch(`${service.origin}/api/sessions/${source.id}/nativecontrols`, { method: 'POST', headers, body: JSON.stringify({ action: 'compact', requestId: crypto.randomUUID(), launchId: native.openCodeLaunchId }) }); assert.equal(refused.ok, false);
        assert.ok((await service.sessions.read(source.id, 120)).screen.includes('KEEP_NATIVE_DRAFT'));
        service.sessions.input(source.id, '\x15'); await page.waitForTimeout(2700);
        const beforeCompactCalls = calls;
        await page.getByRole('button', { name: 'Compact native conversation', exact: true }).click();
        const admitting = page.waitForResponse(response => response.url().endsWith('/nativecontrols') && response.request().postDataJSON()?.action === 'compact');
        await page.getByRole('button', { name: 'Confirm native compaction', exact: true }).click();
        const dispatchResult = await admitting;
        if (dispatchResult) console.log('Native compaction admission:', dispatchResult.status(), JSON.stringify(await dispatchResult.json()));
        await expect.poll(() => calls, { timeout: 20000 }).toBeGreaterThan(beforeCompactCalls);
        await expect(page.getByRole('button', { name: 'Inspect native usage and modes', exact: true })).toBeEnabled({ timeout: 15000 });
        await expect.poll(() => native.activity, { timeout: 30000 }).toBe('idle');
        await post(`/sessions/${source.id}/focus`);
        let settled;
        await expect.poll(async () => { try { settled = await post(`/sessions/${source.id}/nativecontrols`, { action: 'inspect', launchId: native.openCodeLaunchId }); return settled.operation?.status; } catch { return 'inspection pending'; } }, { timeout: 30000 }).toBe('completed');
        const beforeRepeat = calls; await post(`/sessions/${source.id}/nativecontrols`, { action: 'compact', requestId: settled.operation.requestId, launchId: native.openCodeLaunchId }); assert.equal(calls, beforeRepeat);
        await page.getByRole('button', { name: 'Inspect native usage and modes', exact: true }).click();
        await page.screenshot({ path: path.join(root, `.cache/opencode-v${family}-controls-ui.png`) });
        const { OpenCodeTransfer } = await import(pathToFileURL(path.join(serviceRoot, 'opencode-transfer.mjs')));
        const exported = await new OpenCodeTransfer(repo, { family }).read(native.nativeId);
        assert.equal(exported.info.id, initialId); assert.equal(exported.info.agent, 'plan');
        console.log(`PASS OpenCode V${family} production controls: native Plan selection/readback, zero-token usage, preserved draft, same-ID completed compaction and duplicate receipt without replay. Local simulator only.`);
        await page.close(); await service.close(); service = null; mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); mock = null;
        continue;
      }
      await page.getByRole('button', { name: 'Message actions', exact: true }).click();
      const selector = page.getByRole('button', { name: /^Open native (skills and commands|skill selector)$/ }); await expect(selector).toBeEnabled(); const opening = page.waitForResponse(response => response.url().endsWith('/nativecontext') && response.request().method() === 'POST'); await selector.click(); const opened = await opening; assert.ok(opened.ok(), JSON.stringify(await opened.json())); await expect(selector).toHaveCount(0);
      await expect.poll(async () => (await service.sessions.read(source.id, 120)).screen, { timeout: 15000 }).toMatch(/Commands|Select command|Skills/i);
      assert.equal(calls, 0);
      service.sessions.input(source.id, '\x1b');
      await expect.poll(async () => { try { return await service.sessions.permissionReady(native); } catch { return false; } }, { timeout: 15000 }).toBe(true);
      await page.waitForTimeout(2700);
      await page.getByRole('button', { name: 'Message actions', exact: true }).click();
      await page.getByRole('button', { name: 'Prepare working project reference', exact: true }).click();
      await expect.poll(async () => (await service.sessions.read(source.id, 120)).screen.replace(/[\s\\┃│]/g, '')).toContain(repo.replace(/[\s\\]/g, ''));
      assert.equal(calls, 0); assert.equal(native.hasConversation, false);
      await page.screenshot({ path: path.join(root, `.cache/opencode-v${family}-context-ui.png`) });
      console.log(`PASS native OpenCode V${family} context selector and draft-only project reference: zero provider requests.`);
    } else if (!family) {
      const chat = page.getByRole('region', { name: 'Claude graphical chat', exact: true });
      const input = chat.getByRole('textbox', { name: 'Message Claude', exact: true });
      await input.fill('First synthetic input'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true })).toHaveCount(1);
      await input.fill('Second synthetic input'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true })).toHaveCount(2);
      await input.fill('Keep source draft'); await expect.poll(() => service.sessions.get(source.id).graphical.draft).toBe('Keep source draft');
      await chat.getByRole('button', { name: 'Branch from this response', exact: true }).first().click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Branch');
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true })).toHaveCount(1); assert.equal(calls, 2);
      await post(`/sessions/${source.id}/focus`); await page.reload();
      await chat.getByRole('button', { name: 'Edit and branch', exact: true }).last().click();
      await expect(input).toHaveValue('Second synthetic input'); assert.equal(calls, 2);
      await post(`/sessions/${source.id}/focus`); await page.reload();
      await chat.getByRole('button', { name: 'Retry response in a new chat', exact: true }).last().click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Retry'); await expect.poll(() => calls).toBe(3);
      await expect(chat.getByRole('article', { name: 'Claude response', exact: true })).toHaveCount(2);
      assert.equal(service.sessions.get(source.id).graphical.draft, 'Keep source draft');
      await page.screenshot({ path: path.join(root, '.cache/claude-message-actions-ui.png') });
    } else {
      const native = service.sessions.get(source.id);
      await expect.poll(async () => {
        try { return await service.sessions.permissionReady(native); } catch { return false; }
      }, { timeout: 30000 }).toBe(true);
      service.sessions.input(source.id, 'Synthetic source prompt.', { coordinator: true, submit: false });
      await new Promise(resolve => setTimeout(resolve, 500)); await post(`/sessions/${source.id}/control`, { action: 'submit' });
      await expect.poll(() => native.completionVersion, { timeout: 30000 }).toBeGreaterThan(0);
      await expect.poll(() => native.activity).toBe('idle');
      await page.waitForTimeout(2700);
      await expect.poll(async () => { try { return await service.sessions.permissionReady(native); } catch { return false; } }, { timeout: 15000 }).toBe(true);
      service.sessions.input(source.id, 'Synthetic second prompt.', { coordinator: true, submit: false });
      await page.waitForTimeout(500); await post(`/sessions/${source.id}/control`, { action: 'submit' });
      await expect.poll(() => native.completionVersion, { timeout: 30000 }).toBeGreaterThan(1);
      await expect.poll(() => native.activity).toBe('idle');
      const before = calls;
      await page.getByRole('button', { name: 'Message actions', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Native message', exact: true })).toBeVisible({ timeout: 15000 });
      const search = page.getByRole('textbox', { name: 'Search native conversation', exact: true });
      await search.fill('Synthetic second prompt.'); await page.getByRole('button', { name: 'Search history', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Native message', exact: true }).locator('option')).toHaveCount(1);
      await search.fill(''); await page.getByRole('button', { name: 'Search history', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Native message', exact: true }).locator('option')).toHaveCount(4);
      await page.getByRole('button', { name: 'Branch after response', exact: true }).click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Branch', { timeout: 20000 }); assert.equal(calls, before);
      await post(`/sessions/${source.id}/focus`); await page.reload();
      await page.getByRole('button', { name: 'Message actions', exact: true }).click();
      const select = page.getByRole('combobox', { name: 'Native message', exact: true }); await expect(select).toBeVisible({ timeout: 15000 });
      await select.selectOption({ index: 2 }); await page.getByRole('button', { name: 'Edit and branch', exact: true }).click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Branch', { timeout: 30000 });
      const edited = service.sessions.items.get(service.sessions.list().filter(item => item.messageOrigin?.kind === 'edit').at(-1).id);
      await expect.poll(async () => (await service.sessions.read(edited.id, 120)).screen, { timeout: 15000 }).toContain('Synthetic second prompt.');
      assert.equal(calls, before);
      await post(`/sessions/${source.id}/focus`); await page.reload();
      await page.getByRole('button', { name: 'Message actions', exact: true }).click(); await expect(select).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: 'Retry in new branch', exact: true }).click();
      await expect(page.locator('.chat-tab.selected')).toContainText('Retry', { timeout: 30000 });
      await expect.poll(() => calls, { timeout: 30000 }).toBeGreaterThan(before);
      const retry = service.sessions.items.get(service.sessions.list().filter(item => item.messageOrigin?.kind === 'retry').at(-1).id);
      await expect.poll(() => retry.completionVersion, { timeout: 30000 }).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(root, `.cache/opencode-v${family}-message-actions-ui.png`) });
    }
    assert.deepEqual(errors, []); await page.close(); await service.close(); service = null;
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); mock = null; }
    console.log(`PASS provider ${family || 'Claude'}: ${process.argv.includes('--context-only') ? 'native context selectors and draft preparation' : 'UI branch/edit/retry, independent native identity and preserved source'}. Local fixtures only.`);
  }
} catch (error) {
  if (service) {
    console.log('Isolated failure state:', JSON.stringify({ calls, sessions: service.sessions.list().map(item => ({ agent: item.agent, status: item.status, activity: item.activity, completionVersion: item.completionVersion, connectionIssue: item.connectionIssue?.message })) }));
    const selected = service.sessions.active().find(item => item.agent === 'opencode');
    if (selected) { try { await new OpenCodePicker(service.sessions).command(selected.id, 'mcp-ready'); } catch (cause) { console.log('Native readiness refusal:', cause.message); } }
    if (selected) await writeFile(path.join(root, `.cache/provider-actions-native-failure-v${service.sessions.get(selected.id).openCodeFamily}.txt`), (await service.sessions.read(selected.id, 150)).screen.replaceAll(service.token, '<redacted>'));
    if (selected && process.argv.includes('--controls-only')) {
      const native = service.sessions.get(selected.id), receipt = JSON.parse(await readFile(path.join(service.sessions.stateDir, `native-controls-${selected.id}.json`), 'utf8').catch(() => '{}'));
      console.log('Compaction receipt:', JSON.stringify({ operation: receipt.operation && { requestId: receipt.operation.requestId, status: receipt.operation.status } }));
      await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(root, `.cache/opencode-v${native.openCodeFamily}-controls-failure.png`) });
      const { OpenCodeTransfer } = await import(pathToFileURL(path.join(serviceRoot, 'opencode-transfer.mjs')));
      const exported = await new OpenCodeTransfer(native.cwd, { family: native.openCodeFamily }).read(native.nativeId);
      console.log('Native compaction records:', JSON.stringify(exported.messages.filter(m => m.type === 'compaction').map(m => ({ status: m.status, error: m.error }))));
    }
  }
  console.log('Isolated native lifecycle:', JSON.stringify(nativeLifecycle));
  throw error;
} finally {
  await browser?.close(); await service?.close();
  if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);
  await cleanupFixtures();
}
