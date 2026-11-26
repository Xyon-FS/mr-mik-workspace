// Production UI with synthetic provider state. Never starts an authenticated CLI.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { pathToFileURL } from 'node:url';

const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-presentation-'));
const portableIndex = process.argv.indexOf('--portable');
const runtimeRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(base, 'ui') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { CodexChat: PackagedCodex } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const { ClaudeChat: PackagedClaude } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
let service, browser;
const wires = [];
const transcript = `## A clearer response

First paragraph with **an important decision** and an inline \`identifier\`.

Second paragraph, separated so the answer can be read at a glance.

1. Keep the existing files.
2. Review the changes.
   - Check the details.
   - Preserve the draft.

> A quoted observation, separate from the answer.

| Feature | Codex | Claude | Notes |
| --- | --- | --- | --- |
| Rich formatting | Yes | Yes | Shared presentation |
| Native connections | Preserved | Preserved | Existing adapters |
${Array.from({ length: 35 }, (_, index) => `| Capability ${index + 1} | Available | Available | Synthetic table navigation row |`).join('\n')}

\`\`\`typescript
const answer: number = 42;
console.log("A deliberately long line to verify scrolling without widening the chat", answer);
\`\`\`

An equation: $$E = mc^2$$.

\`\`\`mermaid
graph LR
  A[Question] --> B[Answer]
\`\`\`

[Open fixture file](review.txt)

[Unsafe link](javascript:alert(1))

<script>window.unsafeMarkdown = true</script>
`;
try {
  if (portableIndex < 0) {
    await cp(path.join(root, 'dist'), uiDir, { recursive: true });
    // Match desktop/prepare.mjs: Vite deliberately skips the public junction.
    await cp(path.join(root, 'public/assets'), path.join(uiDir, 'assets'), { recursive: true });
  }
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await writeFile(path.join(repo, 'review.txt'), 'Synthetic reference.');
  const progressImage=path.join(repo,'progress-image.png');await writeFile(progressImage,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Presentation fixture'), codex = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new PackagedCodex({ ...options, spawnChild: codex.spawnChild });
    const wire = claudeFixture(options.session.nativeId); wires.push(wire);
    return new PackagedClaude({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const context = await browser.newContext({ viewport: { width: 480, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const agent of ['codex', 'claude']) {
    const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} presentation`, accountProfileId: agent === 'codex' ? profile.id : undefined });
    const runtime = service.sessions.get(session.id).graphical;
    const startedAt = Date.now() - 13000;
    const items = [
      { id: 'question', type: 'userMessage', text: 'Show the result clearly.', turnId: 'presentation', status: 'completed' },
      { id: 'thought', type: 'reasoning', text: 'Recorded public activity summary.', turnId: 'presentation', status: 'completed' },
      { id: 'answer', type: 'agentMessage', text: transcript, turnId: 'presentation', status: 'completed' },
    ];
    const turn = { id: 'presentation', status: 'completed', startedAt, completedAt: startedAt + 13000, durationMs: 13000, timingSource: 'observed' };
    const update = (active = false) => {
      if (agent === 'codex') { runtime.items = new Map(items.map(item => [item.id, { details: '', ...item }])); runtime.turns = new Map([[turn.id, turn]]); runtime.turnId = active ? turn.id : null; }
      else { Object.assign(runtime.protocol.state, { items: structuredClone(items), turns: [structuredClone(turn)], status: active ? 'running' : 'ready' }); }
      runtime.changed();
    };
    update();
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    await page.goto(service.urls.chats);
    const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true });
    const answer = chat.locator('[data-chat-item="answer"]');
    await expect(answer.getByRole('heading', { name: 'A clearer response' })).toBeVisible();

    await expect(answer.locator('.katex')).toHaveCount(1);
    await expect(answer.locator('[data-streamdown="mermaid-block"] svg')).toBeVisible({ timeout: 20000 });
    await expect.poll(() => answer.locator('pre span[style]').count()).toBeGreaterThan(1);
    await expect.poll(() => answer.locator('pre span[style]').evaluateAll(elements => new Set(elements.map(el => getComputedStyle(el).color)).size), { message: `${agent}: syntax tokens must have distinct visible colors` }).toBeGreaterThan(2);
    await expect(chat.locator('.graphical-turn-status')).toHaveCount(1);
    await expect(chat.locator('.graphical-turn-process')).not.toHaveAttribute('open');
    await expect(chat.locator('.graphical-turn-process > summary')).toContainText('Workedfor 13s');
    await chat.locator('.graphical-turn-process > summary').click();
    await expect(chat.locator('.graphical-work-group > summary')).toContainText('Thought summary');
    await chat.locator('.graphical-work-group > summary').click();
    await expect(chat.getByText('Recorded public activity summary.', { exact: true })).toBeVisible();
    await chat.locator('.graphical-work-group > summary').click();
    for (const width of [320, 390, 480, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${agent} ${width}: chat overflow`);
      const prose = await answer.locator('.chat-prose').evaluate(el => ({ paragraph: parseFloat(getComputedStyle(el.querySelector('p')).marginBottom), indent: parseFloat(getComputedStyle(el.querySelector('ol')).paddingLeft), lineHeight: parseFloat(getComputedStyle(el).lineHeight) }));
      assert.ok(prose.paragraph >= 10 && prose.indent >= 20 && prose.lineHeight >= 22, `${agent}: prose hierarchy ${JSON.stringify(prose)}`);
      for (const button of await answer.locator('.chat-rich-block > header button:visible').all()) {
        assert.ok(await button.evaluate(el => { const block = el.closest('.chat-rich-block').getBoundingClientRect(), rect = el.getBoundingClientRect(); return rect.width >= 24 && rect.height >= 24 && rect.left >= block.left && rect.right <= block.right + 1; }), `${agent} ${width}: clipped or undersized block action`);
      }
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    await expect(answer.locator('.chat-rich-block > header').first()).toHaveCSS('flex-wrap', 'nowrap');
    assert.ok(await answer.locator('.chat-rich-block > header').first().evaluate(el => el.getBoundingClientRect().height < 45), 'Output header stays on one compact row');
    const codeBlock = answer.locator('.graphical-code').first(), wrap = page.getByRole('dialog', { name: 'Output options', exact: true }).getByRole('button', { name: 'Wrap code lines', exact: true });
    await codeBlock.getByLabel('Output options', { exact: true }).click(); await expect(wrap).toHaveAttribute('aria-pressed', 'false'); await wrap.click();
    await expect.poll(() => codeBlock.locator('pre').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await answer.getByRole('button', { name: 'Copy code', exact: true }).first().click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), 'const answer: number = 42;\nconsole.log("A deliberately long line to verify scrolling without widening the chat", answer);');
    await codeBlock.screenshot({ path: path.join(root, `.cache/${agent}-chat-code-wrapped-390.png`) });
    await codeBlock.getByLabel('Output options', { exact: true }).click(); await expect(wrap).toHaveAttribute('aria-pressed', 'true'); await wrap.click();
    await expect.poll(() => codeBlock.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(true);
    const table = answer.getByRole('region', { name: 'Scrollable table', exact: true });
    await table.focus(); await table.press('ArrowDown');
    await expect.poll(() => table.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await table.evaluate(el => { el.scrollTop = 300; });
    assert.ok(await table.evaluate(el => Math.abs(el.querySelector('th').getBoundingClientRect().top - el.getBoundingClientRect().top) <= 2), `${agent}: table header disappeared while scrolling`);
    await table.screenshot({ path: path.join(root, `.cache/${agent}-chat-table-scrolled-390.png`) });
    await table.evaluate(el => { el.scrollTop = 0; });
    for (const kind of ['code', 'table']) {
      await expect(answer.getByRole('button', { name: `Expand ${kind}`, exact: true })).toHaveCount(0);
      await expect(answer.getByRole('button', { name: `Open ${kind} in Workspace`, exact: true }).first()).toBeVisible();
    }
    const opened = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}/chat`) && response.request().postDataJSON()?.action === 'open-file');
    await answer.getByRole('link', { name: 'Open fixture file', exact: true }).click(); assert.ok((await opened).ok());
    assert.equal(await page.evaluate(() => !!window.unsafeMarkdown), false);
    assert.equal(await answer.locator('a[href^="javascript:"]').count(), 0);
    await chat.getByLabel('Chat details',{exact:true}).click();await chat.getByRole('tab',{name:'Actions',exact:true}).click();
    await chat.getByRole('button', { name: 'Find in conversation', exact: true }).click();
    await chat.getByRole('button',{name:'Close chat details',exact:true}).click();
    const search = chat.getByRole('textbox', { name: 'Search conversation', exact: true });
    await search.fill('clearer'); await expect(answer.locator('h2 mark')).toHaveText('clearer');
    await search.fill('answer: number'); await expect(answer.locator('pre mark')).toHaveText('answer: number');
    await chat.getByRole('button', { name: 'Close conversation search', exact: true }).click();
    const input = chat.getByRole('textbox', { name: `Message ${agent === 'codex' ? 'Codex' : 'Claude'}`, exact: true });
    await input.fill('Preserve this draft during streaming');
    items[2].text = 'Streaming **partial'; items[2].status = agent === 'claude' ? 'running' : 'inProgress'; turn.status = agent === 'claude' ? 'running' : 'inProgress'; turn.completedAt = null; turn.durationMs = null; update(true);
    await expect(answer.locator('.chat-prose > p strong')).toHaveText('partial'); const workingMark = chat.locator('.graphical-turn-status.active .graphical-working-mark img'); await expect(workingMark).toBeVisible(); await expect.poll(() => workingMark.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true); await expect.poll(() => chat.locator('.graphical-working-caption').first().evaluate(el => getComputedStyle(el.closest('.graphical-work-group > summary') || el).animationName)).toBe('graphical-status-shine');
    const statusRow = chat.locator('.graphical-turn-status.active').first();
    await expect(statusRow.locator('.graphical-working-caption .graphical-elapsed')).toBeVisible();
    const centers=await statusRow.locator('.graphical-working-mark,.graphical-status-label,.graphical-elapsed').evaluateAll(elements=>elements.map(el=>{const box=el.getBoundingClientRect();return box.y+box.height/2}));
    assert.ok(Math.max(...centers)-Math.min(...centers)<=1,'Working icon, text and duration share one center line');
    await page.screenshot({path:path.join(root,'.cache/chat-row-working.png')});

    items[2].text = '```typescript\nconst partial ='; update(true);
    await expect(answer.locator('pre')).toContainText('const partial =');
    items[2].text = transcript; items[2].status = 'completed'; turn.status = 'completed'; turn.completedAt = startedAt + 13000; turn.durationMs = 13000; update();
    await expect(answer.getByRole('heading', { name: 'A clearer response' })).toBeVisible();
    await expect(input).toHaveValue('Preserve this draft during streaming');
    await answer.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded();
    await expect(answer.locator('[data-streamdown="mermaid-block"] svg')).toBeVisible({ timeout: 20000 });
    await chat.locator('.graphical-messages').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, `.cache/${agent}-chat-presentation-390.png`) });
    await answer.locator('.graphical-code').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, `.cache/${agent}-chat-presentation-rich-390.png`) });
    // Mixed failures stay neutral; every new group starts collapsed.
    const commands=[
      {id:'command-failed',type:'commandExecution',text:'synthetic failing command',details:'fixture output',turnId:'presentation',status:'failed',exitCode:1},
      {id:'command-ok',type:'commandExecution',text:'synthetic successful command',details:'fixture output',turnId:'presentation',status:'completed',exitCode:0}
    ];
    items.splice(1,1,...commands);update();
    const work=chat.locator('details.graphical-work-group');
    await expect(work).toHaveCount(1);
    await expect(chat).toHaveAttribute('data-chat-revision', String(runtime.revision));
    const process=chat.locator('.graphical-turn-process');if(!await process.evaluate(el=>el.open))await process.locator(':scope > summary').click();
    await expect(process).toHaveAttribute('open', '');
    await expect(work).not.toHaveAttribute('open');
    await expect(work.locator('summary').first()).toContainText('2 activities');await expect(work.locator('summary').first()).not.toContainText('Failed activity');await expect(work).not.toHaveClass(/failed/);
    commands[1].status='failed';commands[1].exitCode=2;update();
    await expect(work.locator('summary').first()).toContainText('Failed activity');await expect(work).toHaveClass(/failed/);await expect(work).not.toHaveAttribute('open');
    await work.locator('summary').first().click();await expect(work).toHaveAttribute('open','');await expect(work.locator('.graphical-activity.failed')).toHaveCount(2);
    await work.locator('summary').first().click();commands[1].status='completed';commands[1].exitCode=0;update();
    await expect(work).not.toHaveAttribute('open');await expect(work.locator('summary').first()).not.toContainText('Failed activity');
    commands[1].status='inProgress';commands[1].exitCode=null;update();await expect(work).not.toHaveClass(/failed/);await expect(work).not.toHaveAttribute('open');
    commands[1].status='failed';commands[1].exitCode=1;update();await expect(work).not.toHaveAttribute('open');await expect(work).toHaveClass(/failed/);
    await work.locator('summary').first().click();await expect(work).toHaveAttribute('open','');commands[1].status='completed';commands[1].exitCode=0;update();await expect(work).toHaveAttribute('open','');
    await work.locator('summary').first().click();
    // Reading older messages starts with user scroll intent; programmatic
    // scrollIntoView alone intentionally does not disable follow-latest.
    await chat.locator('.graphical-messages').evaluate(el=>el.dispatchEvent(new WheelEvent('wheel',{deltaY:-30,bubbles:true})));
    for(const article of [chat.locator('[data-chat-item="question"]'),answer]){
      await article.scrollIntoViewIfNeeded();await input.focus();await page.mouse.move(0,0);
      const toolbar=article.getByRole('toolbar',{name:'Message actions'});
      await expect.poll(()=>toolbar.evaluate(el=>getComputedStyle(el).opacity)).toBe('0');
      await article.hover();await expect.poll(()=>toolbar.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
      await page.mouse.move(0,0);await toolbar.getByRole('button',{name:'Quote message',exact:true}).focus();await expect.poll(()=>toolbar.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
    }
    await input.focus();await page.mouse.move(0,0);
    items.at(-1).text='Activities completed. Open the activity group to inspect the individual operations.';update();await expect(answer).toContainText('Activities completed.');
    await input.focus();await page.mouse.move(0,0);await expect.poll(()=>answer.getByRole('toolbar',{name:'Message actions'}).evaluate(el=>getComputedStyle(el).opacity)).toBe('0');
    await chat.locator('.graphical-messages').evaluate(el=>{el.scrollTop=0});
    await page.screenshot({path:path.join(root,`.cache/${agent}-activity-disclosure.png`)});
    // Progress prose and each following activity block stay under one user-controlled disclosure.
    const final=items.at(-1);final.phase='final_answer';
    const progress=[{id:'progress-one',type:'agentMessage',phase:'commentary',text:'Inspecting the first section.',turnId:turn.id,status:'completed'},commands[0],{id:'progress-two',type:'agentMessage',phase:'commentary',text:'Checking the second section.',turnId:turn.id,status:'completed'},commands[1]];
    progress[0].attachments=[{path:progressImage,name:'Intermediate image',kind:'image'}];
    if(agent==='codex')progress.splice(2,0,{id:'generated-intermediate',turnId:turn.id,type:'imageGeneration',path:progressImage,status:'completed',text:'',details:''});
    items.splice(1,items.length-1,...progress,final);turn.status='inProgress';update(true);
    const processDetails=chat.locator('.graphical-turn-process');
    if(await processDetails.evaluate(el=>el.open))await processDetails.locator(':scope > summary').click();
    await expect(chat.locator('[data-chat-item="progress-one"]')).toBeHidden();await expect(answer).toBeVisible();await expect(processDetails.locator('.graphical-image')).toHaveCount(0);
    progress[0].text+=' Still inspecting.';update(true);await expect(processDetails).not.toHaveAttribute('open');
    await processDetails.locator(':scope > summary').click();await expect(chat.locator('[data-chat-item="progress-one"]')).toBeVisible();
    await expect(processDetails.locator('.graphical-work-group')).toHaveCount(2);
    await expect(processDetails.locator('[data-chat-item="progress-one"] .graphical-image img')).toBeVisible();
    if(agent==='codex'){const generated=processDetails.locator('[data-chat-item="generated-intermediate"]');await expect(generated.locator('img')).toBeVisible();assert.equal(await generated.evaluate(el=>el.nextElementSibling?.dataset.chatItem),'progress-two','Generated image stays between the activity and next progress message');}
    await page.screenshot({path:path.join(root,`.cache/${agent}-intermediate-images-expanded.png`)});
    assert.equal(await processDetails.locator('.graphical-work-group').first().evaluate(el=>el.previousElementSibling?.dataset.chatItem),'progress-one');
    await processDetails.locator(':scope > summary').click();turn.status='completed';update();await expect(processDetails).not.toHaveAttribute('open');
    const gap=await chat.evaluate(el=>{const user=el.querySelector('[data-chat-item="question"]').getBoundingClientRect(),summary=el.querySelector('.graphical-turn-process>summary').getBoundingClientRect();return summary.top-user.bottom});assert.ok(gap<36,'Reply process follows the question without the old large gap');
    await chat.locator('.graphical-messages').evaluate(el=>{el.scrollTop=0});await page.screenshot({path:path.join(root,`.cache/${agent}-progress-collapsed.png`)});
  }
  const touch=await browser.newContext({viewport:{width:390,height:900},hasTouch:true});
  try{const touchPage=await touch.newPage();await touchPage.goto(service.urls.chats);const touchChat=touchPage.getByRole('region',{name:'Claude graphical chat',exact:true});const action=touchChat.locator('[data-chat-item="answer"]').getByRole('toolbar',{name:'Message actions'});await expect(action).toBeAttached();await expect.poll(()=>action.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');await action.getByRole('button',{name:'Quote message',exact:true}).tap();await expect(touchChat.getByRole('button',{name:'Remove quote',exact:true})).toBeVisible();}finally{await touch.close();}
  assert.deepEqual(errors, []);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(wires.flatMap(wire => wire.calls).filter(call => call.type === 'user').length, 0);
  console.log('PASS shared rich presentation: typography, compact accessible controls, exact copying with optional code wrapping, keyboard-scrollable tables with retained headers, math/diagrams, scoped files, safe Markdown, partial streaming, draft retention, single activity summary, mixed/all-failed states, user-controlled disclosure, hover/focus/touch actions, 320/390/480/1280px. Zero model prompts.');
} finally {
  await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures();
}
