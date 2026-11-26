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
  for (const session of chats) {
    await focus(session.id); await page.goto(service.urls.chats);
    const name=session.agent==='codex'?'Codex':'Claude';
    const chat=page.getByRole('region',{name:`${name} graphical chat`,exact:true});
    const input=chat.getByRole('textbox',{name:`Message ${name}`,exact:true});
    await input.fill('Unsent draft must survive conversation actions');
    await chat.getByLabel('Chat details',{exact:true}).click();
    await chat.getByRole('tab',{name:'Actions',exact:true}).click();
    await chat.getByRole('button',{name:'Pin in History',exact:true}).click();
    await expect.poll(()=>service.sessions.get(session.id).pinned).toBe(true);
    await expect(input).toHaveValue('Unsent draft must survive conversation actions');
    assert.equal(codex.calls.filter(call=>call.method==='turn/start').length,0,'Conversation actions must never submit the composer');
    assert.equal(claudeWires.flatMap(w=>w.calls).filter(call=>call.type==='user').length,0);
    await chat.getByRole('button',{name:'Rename chat',exact:true}).click();
    await expect(chat.locator('form form')).toHaveCount(0);
    assert.ok(await chat.locator('.conversation-actions button').evaluateAll(buttons=>buttons.every(button=>button.type==='button')));
    await chat.getByRole('textbox',{name:'Chat name',exact:true}).fill(`${name} renamed safely`);
    await chat.getByRole('textbox',{name:'Chat name',exact:true}).press('Enter');
    await expect.poll(()=>service.sessions.get(session.id).name).toBe(`${name} renamed safely`);
    await expect(input).toHaveValue('Unsent draft must survive conversation actions');
    assert.equal(codex.calls.filter(call=>call.method==='turn/start').length,0);
    assert.equal(claudeWires.flatMap(w=>w.calls).filter(call=>call.type==='user').length,0);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS navigation action safety: Codex/Claude pin and rename with retained drafts, zero inference and no nested forms.');
} finally { await browser?.close(); await service?.close(); for(const wire of claudeWires)wire.close(); await cleanupFixtures(); }
