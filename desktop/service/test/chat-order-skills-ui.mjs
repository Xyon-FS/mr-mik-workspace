// Chronological steering and inline skills in the compiled UI; synthetic only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
let browser, service; const wires = [], checks = [];
const evidence = path.resolve(process.argv[3] || '.cache/order-skills-ui');
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-order-skills-')), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.resolve(process.argv[2] || 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home,'.codex'), CLAUDE_CONFIG_DIR: path.join(home,'.claude') } }, profileOptions: { root: path.join(base,'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic inline skills'), codex = graphicalFixture({ echoFullInput: true });
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') { const runtime = new CodexChat({ ...options, spawnChild: codex.spawnChild }); runtime.composer.skills = async () => ({ skills: ['review','inspect'].map(name => ({ name, path: path.join(repo,name,'SKILL.md'), description: 'Synthetic skill' })) }); return runtime; }
    const wire = claudeFixture(options.session.nativeId, { commands: [{ name: 'review' }, { name: 'inspect' }, { name: 'compact', builtin: true }] }); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 560, height: 1000 } }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const focus = async session => { await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); await page.goto(service.urls.chats); };
  for (const agent of ['codex','claude']) {
    const create = () => service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const session = await create(), runtime = service.sessions.get(session.id).graphical;
    const turn = { id: 'same-turn', status: 'inProgress', startedAt: Date.now(), completedAt: null, durationMs: null };
    const items = [
      { id: 'u1', type: 'userMessage', text: 'First request' },
      { id: 'p1', type: 'agentMessage', phase: 'commentary', text: 'Earlier public progress' },
      { id: 'c1', type: 'commandExecution', text: 'earlier-command', status: 'completed' },
      { id: 'u2', type: 'userMessage', text: 'Follow-up while working' },
      { id: 'p2', type: 'agentMessage', phase: 'commentary', text: 'Later public progress' },
      { id: 'c2', type: 'commandExecution', text: 'later-command', status: 'inProgress' },
    ];
    const update = () => { const rows = items.map(item => ({ details: '', status: 'completed', turnId: turn.id, ...item })); if (agent === 'codex') { runtime.items = new Map(rows.map(item => [item.id,item])); runtime.turns = new Map([[turn.id,turn]]); runtime.turnId = turn.status === 'inProgress' ? turn.id : null; } else Object.assign(runtime.protocol.state, { items: rows, turns: [{...turn}], status: turn.status === 'inProgress' ? 'running' : 'ready' }); runtime.changed(); };
    update(); await focus(session);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    await expect(chat.locator('.graphical-turn-process')).toHaveCount(2);
    await chat.locator('.graphical-turn-process').first().locator(':scope > summary').click();
    const order = await chat.locator('[data-chat-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-chat-item')));
    assert.deepEqual(order, ['u1','p1','c1','u2','p2','c2']);
    await expect(chat.locator('.graphical-turn-status.active')).toHaveCount(1);
    await chat.screenshot({ path: path.join(evidence,`${agent}-working-order.png`) });
    turn.status = 'completed'; turn.completedAt = Date.now(); items[5].status = 'completed'; items.push({ id: 'final', type: 'agentMessage', phase: agent === 'codex' ? 'final_answer' : undefined, text: 'Final result' }); update();
    await expect(chat.locator('[data-chat-item="final"]')).toBeVisible();
    await expect.poll(() => chat.locator('.graphical-turn-process').evaluateAll(nodes => nodes.every(node => !node.open))).toBe(true);
    await expect(chat.locator('[data-chat-item="u2"]')).toBeVisible();
    items.push({ id: 'late', type: 'commandExecution', text: 'late-command', status: 'completed' }); update();
    await expect(chat.locator('[data-chat-item="late"]')).toHaveCount(1);
    const finalSteps = chat.locator('.graphical-turn-process').filter({ has: page.getByText('Worked', { exact: true }) });
    await expect(finalSteps.locator(':scope > summary')).toContainText('2 activities');
    await expect.poll(() => chat.locator('[data-chat-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-chat-item')))).toEqual(['u1','p1','c1','u2','p2','c2','late','final']);
    const summaryBounds = await finalSteps.locator(':scope > summary').boundingBox();
    const answerBounds = await chat.locator('[data-chat-item="final"]').boundingBox();
    assert.ok(summaryBounds && answerBounds && summaryBounds.y < answerBounds.y, `${agent}: Worked appears above the final reply`);
    await chat.screenshot({ path: path.join(evidence,`${agent}-completed-order.png`) });

    const fresh = await create(); await focus(fresh);
    const draft = chat.getByRole('textbox', { name: agent === 'codex' ? 'Message Codex' : 'Message Claude', exact: true });
    await chat.getByLabel('Add context', { exact: true }).click(); await chat.getByRole('button', { name: 'Choose a skill', exact: true }).click();
    await chat.getByRole('button', { name: /review Synthetic skill|^review$/ }).first().click();
    await expect(draft).toHaveValue('$review ');
    assert.equal(service.sessions.get(fresh.id).graphical.composer.items.length, 0, 'picker inserts editable text without hidden selected skills');
    await expect(chat.getByRole('button', { name: 'Remove skill review', exact: true })).toHaveCount(0);
    await draft.fill(agent === 'codex' ? '$review inspect this with $inspect' : '$review inspect this');
    await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = chat.locator('.graphical-message.userMessage:not(.graphical-send-receipt)');
    try { await expect(sent.locator('.chat-skill-mention')).toHaveCount(agent === 'codex' ? 2 : 1); }
    catch (error) { console.log('Inline skill diagnostic',agent, await chat.innerText(), JSON.stringify(service.sessions.get(fresh.id).graphical.snapshot().items)); throw error; }
    await expect(sent.locator('.katex')).toHaveCount(0);
    await expect(sent.locator('.graphical-sent-context')).toHaveCount(0);
    assert.ok(await sent.locator('.chat-skill-mention').first().evaluate(el => Number(getComputedStyle(el).fontWeight) >= 600));
    if (agent === 'codex') assert.deepEqual(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input.filter(part => part.type === 'skill').map(part => part.name), ['review','inspect']);
    else assert.ok(wires.at(-1).calls.some(call => call.type === 'user' && JSON.stringify(call).includes('/review inspect this')));
    const color = await sent.evaluate(el => getComputedStyle(el).backgroundColor);
    await chat.screenshot({ path: path.join(evidence,`${agent}-inline-skill.png`) });
    for (const width of [320,1000]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1)); await chat.screenshot({path:path.join(evidence,`${agent}-inline-skill-${width}.png`)}); }
    checks.push({ agent, chronological: true, finalCompaction: true, nativeSkill: true, inlineOnly: true, color });
  }
  assert.deepEqual(errors, []); await writeFile(path.join(evidence,'checks.json'), JSON.stringify(checks,null,2)); console.log(JSON.stringify(checks));
} finally { await browser?.close(); await service?.close(); for (const wire of wires) await wire.close(); await cleanupFixtures(); }
