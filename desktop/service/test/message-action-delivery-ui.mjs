// Real React/service, synthetic native transports. No account or model calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-action-delivery-ui-'));
let service, browser;
try {
  browser = await chromium.launch({ env: testBrowserEnvironment(), channel: process.env.MRMAK_TEST_BROWSER || 'msedge', headless: true });
  for (const agent of process.argv.includes('--claude-only') ? ['claude'] : process.argv.includes('--codex-only') ? ['codex'] : ['codex', 'claude']) {
    const folder = path.join(base, agent), repo = path.join(folder, 'hub'), home = path.join(folder, 'home'), config = path.join(folder, 'native');
    await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(config, { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
    await writeFile(path.join(config, 'config.toml'), '# Synthetic');
    service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { ...process.env, CODEX_HOME: config, CLAUDE_CONFIG_DIR: config } }, profileOptions: { root: path.join(folder, 'accounts'), claudeIdentity: async () => ({ status: 'logged-in', identity: 'synthetic-action-delivery' }) } });
    const profile = await service.profiles.create('Synthetic action delivery');
    service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
    const turns = new Map(), transport = graphicalFixture({ turnHistory: turns, completeBeforeResponse: true });
    let claudeCalls = 0;
    service.sessions.createGraphicalRuntime = options => {
      if (agent === 'codex') return new CodexChat({ ...options, spawnChild: transport.spawnChild });
      const fixture = claudeFixture(options.session.nativeId, { effort: options.session.effort, mode: options.session.claudePermissionMode });
      let runtime;
      const factory = input => {
        const wire = fixture.factory(input), send = wire.send.bind(wire);
        wire.send = line => {
          send(line);
          if (JSON.parse(line).type !== 'user') return;
          claudeCalls++;
          const items = runtime.protocol.state.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type));
          const directory = path.join(config, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, `${runtime.session.nativeId}.jsonl`), items.map((item, index) => JSON.stringify({ type: item.type === 'userMessage' ? 'user' : 'assistant', uuid: item.nativeUuid || item.id, parentUuid: index ? items[index - 1].nativeUuid || items[index - 1].id : null, sessionId: runtime.session.nativeId, cwd: repo, isSidechain: false, timestamp: new Date(index + 1).toISOString(), message: { role: item.type === 'userMessage' ? 'user' : 'assistant', ...(item.type === 'agentMessage' ? { id: item.id.slice(0, item.id.lastIndexOf(':')), stop_reason: 'end_turn' } : {}), content: [{ type: 'text', text: item.text }] } })).join('\n') + '\n');
        };
        return wire;
      };
      runtime = new ClaudeChat({ ...options, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, transportFactory: factory }); return runtime;
    };
    const created = await service.sessions.create({ agent, chatInterface: 'chat', name: 'Synthetic original', accountProfileId: agent === 'codex' ? profile.id : 'system', cwd: repo, effort: 'low', codexPermissions: 'bypass' });
    const source = service.sessions.get(created.id), runtime = source.graphical;
    if (agent === 'codex') {
      const recorded = [1, 2].map(number => ({ id: `turn-${number}`, status: 'completed', items: [{ id: `user-${number}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${number}` }] }, { id: `answer-${number}`, type: 'agentMessage', text: `Answer ${number}`, status: 'completed' }] }));
      turns.set(source.nativeId, recorded);
      for (const turn of recorded) { runtime.rememberTurn(turn); for (const item of turn.items) runtime.upsert(item, { turnId: turn.id }); }
      service.sessions.changed(source);
    } else { await runtime.submit('First synthetic input'); await runtime.submit('Second synthetic input'); }
    const calls = () => agent === 'codex' ? transport.calls.filter(call => call.method === 'turn/start').length : claudeCalls;
    const baseline = calls(), headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const post = async (route, body = {}) => { const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers, body: JSON.stringify(body) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; };
    await post(`/sessions/${source.id}/focus`);
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    const retry = chat.getByRole('button', { name: 'Retry response in a new chat', exact: true }).last();
    await expect(retry).toBeEnabled();
    const requests = [];
    let lost = 0;
    await page.route('**/messageaction', async route => {
      requests.push(route.request().postDataJSON());
      await route.fetch(); await route.abort('failed'); lost++;
    });
    await retry.click(); await expect.poll(calls).toBe(baseline + 1); await expect.poll(() => lost).toBe(1);
    await post(`/sessions/${source.id}/focus`); await page.reload();
    await expect(retry).toBeEnabled();
    await retry.click(); await expect.poll(() => requests.length).toBe(2);
    await expect.poll(() => lost).toBe(2);
    // Wait for the second accepted HTTP request before checking native dispatch.
    if (!process.argv.includes('--navigation-only')) {
      assert.equal(requests[1].requestId, requests[0].requestId, `${agent}: an ambiguous retry must retain its request identity after reload`);
      assert.equal(calls(), baseline + 1, `${agent}: a lost reply must not start another response`);
      assert.equal(service.sessions.items.size, 2, `${agent}: exactly one retry child`);
    }
    const other = service.sessions.list().find(item => item.id !== source.id);
    await page.unroute('**/messageaction');
    await post(`/sessions/${source.id}/focus`); await page.reload();
    let release, fetched = false;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/messageaction', async route => {
      const response = await route.fetch(); fetched = true;
      await held; await route.fulfill({ response });
    });
    try {
      await chat.getByRole('button', { name: 'Branch from this response', exact: true }).last().click();
      await expect.poll(() => fetched).toBe(true);
      await post(`/sessions/${other.id}/focus`);
      await expect(page.locator('.project-chat-current strong')).toHaveText(other.name);
      const finished = page.waitForResponse(response => response.url().endsWith('/messageaction'));
      release(); await (await finished).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator('.project-chat-current strong')).toHaveText(other.name);
    } finally { release(); await page.unroute('**/messageaction'); }
    await post(`/sessions/${source.id}/focus`); await page.reload();
    let begin, intercepted = false;
    const delayedRequest = new Promise(resolve => { begin = resolve; });
    await page.route('**/messageaction', async route => {
      intercepted = true; await delayedRequest;
      const response = await route.fetch(); await route.fulfill({ response });
    });
    try {
      await chat.getByRole('button', { name: 'Branch from this response', exact: true }).last().click();
      await expect.poll(() => intercepted).toBe(true);
      await post(`/sessions/${other.id}/focus`);
      await expect(page.locator('.project-chat-current strong')).toHaveText(other.name);
      const finished = page.waitForResponse(response => response.url().endsWith('/messageaction'));
      begin(); await (await finished).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator('.project-chat-current strong')).toHaveText(other.name);
    } finally { begin(); await page.unroute('**/messageaction'); }
    assert.deepEqual(errors, []);
    await page.close(); await service.close(); service = null;
    console.log(`PASS ${agent}: retry identity, one child and one inference across lost reply/reload; delayed success preserves newer navigation.`);
  }
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
