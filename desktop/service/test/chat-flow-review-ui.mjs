// Production UI with isolated services and controlled slow/error native paths.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
import {mkdtemp, createService, cleanupFixtures, testBrowserEnvironment} from './fixtures.mjs';
import {CodexChat} from '../codex-chat.mjs';
import {ClaudeChat} from '../claude-chat.mjs';
import {randomUUID} from 'node:crypto';
import {graphicalFixture} from './codex-chat-fixture.mjs';
import {claudeFixture} from './claude-chat-fixture.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve=done; }); return {promise, resolve}; };
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-flow-review-'));
let browser, service; const gates = [], wires = [], errors = [], evidence = [];
try {
  const repo=path.join(base,'hub'),home=path.join(base,'home');
  await mkdir(path.join(repo,'workspace'),{recursive:true}); await mkdir(home);
  await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
  service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}}});
  const profile=await service.profiles.create('Fast registry name');
  const claude=await service.claudeProfiles.create('Claude registry name');
  const codexGate=deferred(),claudeGate=deferred(); gates.push(codexGate,claudeGate); let claudeReads=0,genericReads=0;
  service.accounts.profileInventory=()=>codexGate.promise;
  service.accounts.claudeInventory=()=>{claudeReads++;return claudeGate.promise;};
  service.accounts.inventory=async()=>{genericReads++;return [];};
  browser=await chromium.launch({headless:true,channel:'msedge',env:testBrowserEnvironment()});
  const page=await browser.newPage({viewport:{width:1100,height:850}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(service.urls.workspace);await page.getByRole('button',{name:'Toggle settings',exact:true}).click();
  await expect.poll(()=>page.locator('img.mak-logo').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
  await page.getByRole('button',{name:'Accounts settings',exact:true}).click();
  const codexRegion=page.getByRole('region',{name:'Codex account profiles',exact:true});
  await expect(codexRegion.getByText('Fast registry name',{exact:true})).toBeVisible();
  await expect(codexRegion.locator('.account-status')).toContainText('Checking status…');
  assert.equal(claudeReads,0);assert.equal(genericReads,0);
  codexGate.resolve([{...profile,available:true,status:'logged-in'}]);
  await expect(codexRegion.locator('.account-status')).toContainText('Logged in');
  // Refresh an already-populated list while native status is held: registry
  // changes must still appear without waiting for the slow process response.
  const refreshGate=deferred();gates.push(refreshGate);service.accounts.profileInventory=()=>refreshGate.promise;
  await service.profiles.rename(profile.id,'Renamed registry account');
  const added=await service.profiles.create('New registry account');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(codexRegion.getByText('Renamed registry account',{exact:true})).toBeVisible();
  await expect(codexRegion.getByText('New registry account',{exact:true})).toBeVisible();
  await expect(codexRegion.getByText('Fast registry name',{exact:true})).toHaveCount(0);
  refreshGate.resolve([{...profile,label:'Renamed registry account',available:true,status:'logged-in'},{...added,available:true,status:'logged-out'}]);
  await expect(codexRegion.locator('.account-row').filter({hasText:'New registry account'}).locator('.account-status')).toContainText('Not logged in');
  await page.getByRole('group',{name:'Account provider'}).getByRole('button',{name:'Claude',exact:true}).click();
  const claudeRegion=page.getByRole('region',{name:'Claude account profiles',exact:true});
  await expect(claudeRegion.getByText('Claude registry name',{exact:true})).toBeVisible();
  await expect(claudeRegion.getByText('Checking status…',{exact:true}).first()).toBeVisible();
  claudeGate.resolve([{...claude,available:true,status:'logged-in'}]);
  await expect(claudeRegion.locator('.account-row').filter({hasText:'Claude registry name'}).locator('.account-status')).toContainText('Logged in');
  assert.equal(genericReads,0); evidence.push({scenario:'registry names visible before native status',passed:true});
  await page.keyboard.press('Escape');
  service.sessions.verifyAccount=async()=>{};service.sessions.verifyIdentity=async()=>{};
  service.sessions.captureTools=async()=>({});service.sessions.prepareLaunch=async()=>null;service.sessions.prepareBrowser=async()=>null;
  const wire=graphicalFixture();
  service.sessions.createGraphicalRuntime=options=>{
    if(options.session.agent==='codex')return new CodexChat({...options,spawnChild:wire.spawnChild});
    const mock=claudeFixture(options.session.nativeId);wires.push(mock);return new ClaudeChat({...options,transportFactory:mock.factory});
  };
  for(const agent of ['codex','claude']) {
    const session=await service.sessions.create({agent,chatInterface:'chat',accountProfileId:agent==='codex'?profile.id:claude.id,cwd:repo});
    const runtime=service.sessions.get(session.id).graphical;
    const all=Array.from({length:80},(_,n)=>({id:`${agent}-${n}`,turnId:`turn-${Math.floor(n/2)}`,type:n%2?'agentMessage':'userMessage',text:`${n%2?'Response':'Question'} ${n} ${'Synthetic reading text. '.repeat(n<78?20:1)}`,phase:n%2?'final_answer':undefined,status:'completed',details:''}));
    const turns=Array.from({length:40},(_,n)=>({id:`turn-${n}`,status:'completed'}));
    if(agent==='codex'){runtime.items=new Map(all.slice(-2).map(item=>[item.id,item]));runtime.turns=new Map(turns.map(turn=>[turn.id,turn]));runtime.truncated=true;}
    else{Object.assign(runtime.protocol.state,{items:all.slice(-2),turns,status:'ready'});runtime.hasOlder=true;}
    let requests=0;
    runtime.older=async({beforeId})=>{requests++;const end=all.findIndex(item=>item.id===beforeId),start=Math.max(0,end-12);return{items:all.slice(start,end),turns,nextCursor:start?String(start):null,hasOlder:start>0};};runtime.changed();
    await fetch(service.origin+`/api/sessions/${session.id}/focus`,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{}'});
    await page.goto(service.urls.chats);
    await expect.poll(()=>page.locator('img.mak-logo').evaluateAll(images=>images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true);
    const chat=page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}),view=chat.locator('.graphical-messages');
    await expect(chat).toBeVisible();await expect.poll(()=>requests).toBeGreaterThan(0);
    await expect(chat.locator(`[data-chat-item="${agent}-77"]`)).toHaveCount(1);
    const before=requests;
    // An upward intent at an already-reached boundary must work even if the
    // browser cannot generate another scroll-position change.
    await view.evaluate(element=>{element.scrollTop=0;element.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,bubbles:true}));});
    await expect.poll(()=>requests).toBeGreaterThan(before);
    await page.screenshot({path:path.resolve(`.cache/chat-flow-review-${agent}.png`)});
    evidence.push({agent,scenario:'automatic sparse-history fill and top-boundary paging',requests,passed:true});
    const oldRead=deferred(),newRead=deferred();gates.push(oldRead,newRead);let concurrentReads=0;
    runtime.older=async({beforeId})=>{const n=++concurrentReads;await(n===1?oldRead.promise:newRead.promise);const end=all.findIndex(item=>item.id===beforeId);return{items:all.slice(Math.max(0,end-12),end),turns,nextCursor:null,hasOlder:false};};
    await view.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,bubbles:true}));});await expect.poll(()=>concurrentReads).toBe(1);
    runtime.runtimeId=randomUUID();
    const tail=all.slice(-2).map(item=>({...item,text:'Reconnected runtime '+item.id}));
    if(agent==='codex'){runtime.items=new Map(tail.map(item=>[item.id,item]));runtime.truncated=true;}else{runtime.protocol.state.items=tail;runtime.hasOlder=true;}
    runtime.changed();await expect(chat.locator(`[data-chat-item="${agent}-79"]`)).toContainText('Reconnected runtime');
    await view.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,bubbles:true}));});await expect.poll(()=>concurrentReads).toBe(2);
    oldRead.resolve();await page.waitForTimeout(100);await view.evaluate(el=>el.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,bubbles:true})));await page.waitForTimeout(100);assert.equal(concurrentReads,2,'An old request must not release the new runtime request lock');
    newRead.resolve();await expect(chat.getByRole('button',{name:'Loading history…',exact:true})).toHaveCount(0);
    evidence.push({agent,scenario:'new runtime pages while stale request is pending; old completion preserves new request lock',passed:true});
    await service.sessions.remove(session.id);
    const collapsed=await service.sessions.create({agent,chatInterface:'chat',accountProfileId:agent==='codex'?profile.id:claude.id,cwd:repo});
    const compact=service.sessions.get(collapsed.id).graphical;
    const work=Array.from({length:1000},(_,n)=>({id:`work-${agent}-${n}`,turnId:'one-large-turn',type:agent==='codex'?'commandExecution':'tool',status:'completed',text:'Synthetic operation',details:''}));
    if(agent==='codex'){compact.items=new Map(work.slice(-1).map(item=>[item.id,item]));compact.truncated=true;}
    else{Object.assign(compact.protocol.state,{items:work.slice(-1),turns:[],status:'ready'});compact.hasOlder=true;}
    let compactRequests=0;
    compact.older=async({beforeId})=>{compactRequests++;const end=work.findIndex(item=>item.id===beforeId),start=Math.max(0,end-12);return{items:work.slice(start,end),turns:[],hasOlder:start>0,nextCursor:start?String(start):null};};compact.changed();
    await fetch(service.origin+`/api/sessions/${collapsed.id}/focus`,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{}'});
    await page.goto(service.urls.chats);await expect.poll(()=>compactRequests).toBe(3);await page.waitForTimeout(250);assert.equal(compactRequests,3,'Collapsed activities must not drain the entire native history');
    await page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}).locator('.graphical-messages').evaluate(element=>element.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,bubbles:true})));
    await expect.poll(()=>compactRequests).toBeGreaterThan(3);await service.sessions.remove(collapsed.id);
    evidence.push({agent,scenario:'collapsed activities cap automatic backfill but permit explicit upward intent',passed:true});
  }
  assert.deepEqual(errors,[]);await writeFile(path.resolve('.cache/chat-flow-review-ui.json'),JSON.stringify(evidence,null,2));
  console.log('PASS: registry-first account lists, no hidden-provider probes, both-provider sparse history and scroll-boundary paging.');
} finally {
  for(const gate of gates)gate.resolve([]);
  await browser?.close();await service?.close();await cleanupFixtures();
}
