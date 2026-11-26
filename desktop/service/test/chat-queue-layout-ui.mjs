// Production UI/service acceptance, synthetic Claude wire, no user Hub/accounts.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const serviceRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(serviceRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
let service, browser;
try {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-queue-ui-')), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const isolatedUi=path.join(base,'ui');await cp(uiDir,isolatedUi,{recursive:true});await cp(path.join(root,'public/assets'),path.join(isolatedUi,'assets'),{recursive:true});
  service = await createService({ repo, uiDir:isolatedUi, mcpOptions: { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  let wire;
  service.sessions.createGraphicalRuntime = options => { wire = claudeFixture(options.session.nativeId); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  const session = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, name: 'Claude queue acceptance' });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = async (action, body) => {
    const result = await fetch(`${service.origin}/api/sessions/${session.id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) }); return result;
  };
  assert.ok((await post('focus', {})).ok);
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: 'Claude graphical chat', exact: true }), input = chat.getByRole('textbox', { name: 'Message Claude', exact: true });
  const queue = chat.getByRole('region', { name: 'Queued messages', exact: true });
  await input.fill('slow'); await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.getByRole('button', { name: 'Interrupt response', exact: true })).toBeEnabled();
  await input.fill('first queued'); await chat.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(queue).toContainText('first queued');
  for(let i=0;i<3;i++){await input.fill('Queued message '+i);await chat.getByRole('button',{name:'Queue message',exact:true}).click();}
  const runtime=service.sessions.get(session.id).graphical,transport=[...wire.transports][0];transport.emit({type:'assistant',session_id:runtime.session.nativeId,message:{id:'spawn-combined',content:[{type:'tool_use',id:'toolu_combined',name:'Agent',input:{description:'Concurrent child',subagent_type:'general-purpose',prompt:'Inspect synthetic data'}}]}});transport.emit({type:'assistant',session_id:runtime.session.nativeId,parent_tool_use_id:'toolu_combined',message:{id:'combined-child-text',content:[{type:'text',text:'Read-only synthetic child result'}]}});
  const sub=chat.getByRole('region',{name:'Subagents',exact:true});await sub.getByRole('button',{name:/^Subagents/}).click();await expect(sub).toContainText('Read-only synthetic child result');
  const metrics=[];
  for(const size of [{width:390,height:420},{width:650,height:480},{width:1100,height:800}]){
    await page.setViewportSize(size);
    const geometry=await chat.evaluate(el=>({chat:el.getBoundingClientRect().toJSON(),composer:el.querySelector('.graphical-composer').getBoundingClientRect().toJSON(),subagents:el.querySelector('.subagents-panel').getBoundingClientRect().toJSON(),queue:el.querySelector('.graphical-queue').getBoundingClientRect().toJSON()}));metrics.push({size,geometry});assert.ok(geometry.composer.bottom<=size.height,'Combined queue/subagents retains composer');
    await page.screenshot({path:path.resolve(`.cache/continued-combined-queue-${size.width}-${size.height}-after.png`)});
  }
  console.log(JSON.stringify(metrics,null,2));
  await writeFile(path.resolve('.cache/continued-combined-queue-after.json'),JSON.stringify(metrics,null,2));
  const support=chat.locator('.graphical-support');
  for(const size of [{width:390,height:420},{width:650,height:480}]) {
    await page.setViewportSize(size);
    for(const control of [queue.getByRole('button',{name:'Edit',exact:true}).first(),sub.getByRole('button',{name:'Refresh subagent',exact:true})]) {
      await input.focus(); await control.focus(); await page.waitForTimeout(80);
      const visible=await control.evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.graphical-support').getBoundingClientRect();return {label:el.textContent,support:p.toJSON(),height:r.height,visible:Math.max(0,Math.min(r.bottom,p.bottom)-Math.max(r.top,p.top))}});
      assert.ok(visible.visible>=visible.height-1,JSON.stringify(visible));
    }
    await queue.getByRole('button',{name:'Edit',exact:true}).first().click();
    const edit=queue.getByRole('textbox',{name:'Edit queued message',exact:true});await edit.fill('Edited in the bounded queue');
    await queue.getByRole('button',{name:'Save',exact:true}).first().click();await expect(queue).toContainText('Edited in the bounded queue');
    assert.ok(await support.evaluate(el=>el.scrollHeight>el.clientHeight),'Combined panels remain scrollable');
    const longDraft=Array.from({length:25},(_,i)=>'Unsent draft line '+i).join('\n');await input.fill(longDraft);await expect(input).toHaveValue(longDraft);
    assert.ok(await input.evaluate(el=>el.clientHeight<=60&&el.scrollHeight>el.clientHeight),'Draft remains internally scrollable');
    await input.fill('');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS combined queue/subagents: composer bounds, reachable queue and agent controls, editing, long draft preservation and scrolling; synthetic provider only.');
} finally {await browser?.close();await service?.close();await cleanupFixtures();}
