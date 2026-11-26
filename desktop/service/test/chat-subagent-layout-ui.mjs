// Isolated production UI. Synthetic protocol only; no login, paid calls or PTY.
import assert from 'node:assert/strict';
import { revealProcessFor } from './chat-disclosure-ui.mjs';
import path from 'node:path';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const root = path.resolve('.');
const base = await mkdtemp(path.join(root, '.cache/graphical-operations-ui-'));
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home'), nativeHome = path.join(home, '.codex'), uiDir = path.join(base, 'ui');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(nativeHome, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}'); await writeFile(path.join(nativeHome, 'config.toml'), '# Synthetic fixture\n');
  await cp(path.join(root,'dist'),uiDir,{recursive:true});await cp(path.join(root,'public/assets'),path.join(uiDir,'assets'),{recursive:true});
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { ...process.env, CODEX_HOME: nativeHome } }, profileOptions: { root: path.join(base, 'accounts') } });
  const profile = await service.profiles.create('Operations fixture');
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({}); service.accounts.status = async () => 'logged-in';
  const transport = graphicalFixture({ approval: true });
  service.sessions.createGraphicalRuntime = options => new CodexChat({ ...options, spawnChild: transport.spawnChild });
  const session = await service.sessions.create({ agent: 'codex', name: 'Operations fixture', chatInterface: 'chat', accountProfileId: profile.id, codexPermissions: 'auto-review', effort: 'medium', cwd: repo });
  const runtime = service.sessions.get(session.id).graphical, child = transport.children[0];
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 650, height: 1050 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Codex graphical chat', exact: true }); await expect(chat).toBeVisible();
  transport.history.set('fixture-child', [{ id: 'child-result', type: 'agentMessage', text: 'Agent inspected the source.' }]);
  child.notify('item/completed', { threadId: runtime.threadId, turnId: 'agent-parent-turn', item: { id: 'child-call', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['fixture-child'], agentsStates: { 'fixture-child': { status: 'completed', message: 'Inspection finished.' } }, prompt: 'Inspect source' } });
  await expect(chat.getByRole('region', { name: 'Subagents', exact: true })).toBeVisible();
  const group = chat.locator('.graphical-work-group').last();
  await revealProcessFor(group);
  if (!(await group.getAttribute('open'))) await group.locator(':scope > summary').click();
  await expect(chat.locator('.graphical-agents')).toHaveCount(1);
  await page.route('**/api/sessions/*/chat',async route=>{if(route.request().postDataJSON()?.action!=='agent-read')return route.continue();const response=await route.fetch();const data=await response.json();data.name='LongSubagentName'.repeat(18);data.role='LongSpecialistRole'.repeat(12);await route.fulfill({response,json:data});});
  await chat.getByRole('button', { name: 'View agent', exact: true }).click();
  const agent = page.getByRole('dialog', { name: 'Agent conversation', exact: true });
  await expect(agent).toContainText('LongSubagentName'); await expect(agent).toContainText('Agent inspected the source.');
  await expect(agent.getByRole('textbox')).toHaveCount(0);
  const agentBounds = await agent.boundingBox(); assert.ok(agentBounds.x >= 8 && agentBounds.y >= 8 && agentBounds.x + agentBounds.width <= 650 && agentBounds.y + agentBounds.height <= 1050);
  await page.screenshot({ path: path.join(root, '.cache/codex-chat-agent-reader.png') });
  const evidence=[];
  for(const size of [{width:390,height:640},{width:650,height:480},{width:1100,height:800}]) {
    await page.setViewportSize(size);
    await expect(agent).toBeVisible();
    const metrics=await agent.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,height:el.clientHeight,scrollHeight:el.scrollHeight,box:el.getBoundingClientRect().toJSON()}));
    await page.screenshot({path:path.join(root,`.cache/continued-agent-reader-after-${size.width}-${size.height}.png`)});
    evidence.push({size,metrics});assert.ok(metrics.scroll<=metrics.width+1,'Long subagent identity fits its dialog');const closeBox=await agent.getByRole('button',{name:'Close agent',exact:true}).boundingBox();assert.ok(closeBox.x>=0&&closeBox.x+closeBox.width<=size.width,'Close remains inside viewport');
  }
  // Native dialog blank padding is interior, not its backdrop.
  const interior=await agent.boundingBox();await page.mouse.click(interior.x+4,interior.y+4);
  const retained=await agent.count();assert.equal(retained,1,'Interior dialog padding must not act as backdrop');
  evidence.push({interiorPaddingRetained:retained});
  if(retained){await page.mouse.click(2,300);await expect(agent).toHaveCount(0);await expect(chat.getByRole('button',{name:'View agent',exact:true})).toBeFocused();}
  const sub=chat.getByRole('region',{name:'Subagents',exact:true});
  await sub.getByRole('button',{name:/^Subagents/}).click();
  await expect(sub.getByLabel('Subagent transcript',{exact:true})).toContainText('Agent inspected');
  for(const size of [{width:390,height:420},{width:650,height:420},{width:650,height:480},{width:390,height:640}]) {
    await page.setViewportSize(size);
    await page.evaluate(()=>document.documentElement.style.fontSize='');
    await page.screenshot({path:path.join(root,`.cache/continued-subagents-after-${size.width}-${size.height}.png`)});
    const geometry=await sub.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,box:el.getBoundingClientRect().toJSON(),composer:el.closest('.graphical-chat').querySelector('.graphical-composer').getBoundingClientRect().toJSON()}));
    evidence.push({size,subagent:geometry});assert.ok(geometry.composer.bottom<=size.height,'Subagents retain complete composer in short windows');assert.ok(geometry.scrollWidth<=geometry.width+1,'Panel has no horizontal overflow');
    const content=sub.locator('.subagents-content');const refresh=sub.getByRole('button',{name:'Refresh subagent',exact:true});await sub.getByRole('button',{name:/^Subagents/}).focus();await refresh.focus();
    const visible=await refresh.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.subagents-content').getBoundingClientRect();return {button:r.toJSON(),content:p.toJSON(),height:r.height,visibleHeight:Math.max(0,Math.min(r.bottom,p.bottom)-Math.max(r.top,p.top))}});console.log('CLIPPED_CONTROL',JSON.stringify({size,visible}));assert.ok(visible.visibleHeight>=visible.height-1,'Subagent refresh is fully visible within its clipped scrolling panel');
    await content.evaluate(el=>el.scrollTop=el.scrollHeight);const note=sub.locator('.subagents-note');const noteVisible=await note.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.subagents-content').getBoundingClientRect();return Math.min(r.bottom,p.bottom)-Math.max(r.top,p.top)});assert.ok(noteVisible>=10,'Recorded transcript end remains readable after scrolling');
    await page.screenshot({path:path.join(root,`.cache/continued-subagents-after-scrolled-${size.width}-${size.height}.png`)});
  }
  await page.setViewportSize({width:390,height:420});const input=chat.getByRole('textbox',{name:'Message Codex',exact:true});const draft='Retained line\n'.repeat(25);await input.fill(draft);await expect(input).toHaveValue(draft);const inputGeometry=await input.evaluate(el=>{el.scrollTop=el.scrollHeight;return {height:el.getBoundingClientRect().height,client:el.clientHeight,scroll:el.scrollHeight,top:el.scrollTop,bottom:el.closest('.graphical-composer').getBoundingClientRect().bottom}});assert.ok(inputGeometry.height<=61&&inputGeometry.scroll>inputGeometry.client&&inputGeometry.top>0,'Long short-window draft scrolls internally without losing text');assert.ok(inputGeometry.bottom<=420,'Long draft retains the complete composer');await page.screenshot({path:path.join(root,'.cache/continued-subagents-long-draft-after.png')});
  await writeFile(path.join(root,'.cache/continued-agent-metrics-after.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  assert.deepEqual(errors,[]);assert.ok(!transport.calls.some(call=>call.method==='turn/start'));console.log('PASS subagent reader interior/backdrop, short-window composer and scrollable panel; zero inference.');
} finally { await browser?.close(); await service?.close(); await cleanupFixtures(); }
