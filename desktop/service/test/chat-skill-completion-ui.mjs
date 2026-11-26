// Compiled UI, isolated service and native protocol fixtures; no live accounts.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {mkdtemp,createService,cleanupFixtures,testBrowserEnvironment} from './fixtures.mjs';
import {graphicalFixture} from './codex-chat-fixture.mjs';
import {claudeFixture} from './claude-chat-fixture.mjs';
import {CodexChat} from '../codex-chat.mjs';
import {ClaudeChat} from '../claude-chat.mjs';
let browser,service;const wires=[],checks=[];
const evidence=path.resolve('.cache/centered-chat-skills');
try{
 const base=await mkdtemp(path.join(os.tmpdir(),'mik-completion-ui-')),repo=path.join(base,'hub'),home=path.join(base,'home');
 await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await mkdir(evidence,{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}},profileOptions:{root:path.join(base,'accounts')}});
 service.sessions.verifyAccount=async()=>{};service.sessions.verifyIdentity=async()=>{};service.sessions.captureTools=async()=>({});
 const profile=await service.profiles.create('Synthetic autocomplete'),codex=graphicalFixture({echoFullInput:true}),controls=new Map();
 const names=['review','inspect','workspace-authoring','plan','feature-handoff','game-ui-workflow'];
 service.sessions.createGraphicalRuntime=options=>{
  let runtime;if(options.session.agent==='codex')runtime=new CodexChat({...options,spawnChild:codex.spawnChild});else{const wire=claudeFixture(options.session.nativeId,{commands:names.map(name=>({name}))});wires.push(wire);runtime=new ClaudeChat({...options,transportFactory:wire.factory});}
  const state={calls:0,fail:false,names:[...names]};controls.set(options.session.id,state);
  runtime.composer.skills=async()=>{state.calls++;await state.gate;if(state.fail)throw Error('Synthetic catalog unavailable');return{skills:state.names.map(name=>({name,path:options.session.agent==='claude'?`native:${name}`:path.join(repo,name,'SKILL.md'),description:`Use ${name} for this workspace.`})),warnings:''};};return runtime;
 };
 browser=await chromium.launch({channel:'chrome',headless:true,env:testBrowserEnvironment()});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const agent of ['codex','claude']){
  const codexBefore=codex.calls.filter(call=>call.method==='turn/start').length,claudeBefore=wires.flatMap(wire=>wire.calls).filter(call=>call.type==='user').length;
  const session=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,accountProfileId:agent==='codex'?profile.id:undefined}),runtime=service.sessions.get(session.id).graphical,control=controls.get(session.id);
  const headers={Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'};
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`,{method:'POST',headers,body:'{}'});await page.goto(service.urls.chats);await page.bringToFront();
  const chat=page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}),input=chat.getByRole('textbox',{name:agent==='codex'?'Message Codex':'Message Claude',exact:true}),list=chat.getByRole('listbox',{name:'Available skills',exact:true});
  await input.fill('Ordinary draft');assert.equal(control.calls,0,'Do not preload the catalog for ordinary typing');
  await input.fill('$');await expect(list.getByRole('option')).toHaveCount(names.length);assert.equal(control.calls,1);
  await input.fill('$r');await input.fill('$rev');await expect(list.getByRole('option')).toHaveCount(1);assert.equal(control.calls,1,'Filtering must not refetch the catalog');
  await input.press('Enter');await expect(input).toHaveValue('$review ');await expect(list).toHaveCount(0);await expect(chat.locator('.graphical-draft-mirror strong')).toHaveText('$review');await expect(input).toHaveCSS('color','rgba(0, 0, 0, 0)');await chat.screenshot({path:path.join(evidence,`${agent}-draft-skill.png`)});
  assert.equal(codex.calls.filter(call=>call.method==='turn/start').length,codexBefore,'Completion must not send a message');assert.equal(wires.flatMap(wire=>wire.calls).filter(call=>call.type==='user').length,claudeBefore);
  await input.fill('$');await expect(list.getByRole('option')).toHaveCount(names.length);await input.press('ArrowDown');await input.press('Enter');await expect(input).toHaveValue('$inspect ');
  await input.fill('$zzzz');await expect(list).toContainText('No available skills match.');await input.press('Enter');await expect(input).toHaveValue('$zzzz');await input.press('Escape');await expect(list).toHaveCount(0);
  const before=control.calls;await input.fill('```text\n$review\n```');await expect(list).toHaveCount(0);assert.equal(control.calls,before);
  await input.fill('Before $rev suffix');await input.evaluate(element=>{element.setSelectionRange(11,11);document.dispatchEvent(new Event('selectionchange'));});await expect(list.getByRole('option')).toHaveCount(1);await list.getByRole('option').click();await expect(input).toHaveValue('Before $review suffix');
  await input.fill('$');await expect(list.getByRole('option')).toHaveCount(names.length);await chat.locator('.graphical-messages').click({position:{x:5,y:5}});await expect(list).toHaveCount(0);
  await input.click();await expect(list.getByRole('option')).toHaveCount(names.length);await input.press('Tab');await expect(list).toHaveCount(0);
  control.fail=true;await input.fill('New $');await expect(list.getByRole('alert')).toContainText('Synthetic catalog unavailable');control.fail=false;await list.getByRole('button',{name:'Retry',exact:true}).click();await expect(list.getByRole('option')).toHaveCount(names.length);
  const item={id:'layout-answer',turnId:'layout-turn',type:'agentMessage',phase:'final_answer',status:'completed',details:'',text:'A centered answer.\n\n```typescript\nconst value = 1;\n```\n\n| Item | Value |\n| --- | --- |\n| Example | 1 |'};
  if(agent==='codex'){runtime.items.set(item.id,item);runtime.turns.set('layout-turn',{id:'layout-turn',status:'completed'});}else Object.assign(runtime.protocol.state,{items:[item],turns:[{id:'layout-turn',status:'completed'}],status:'ready'});runtime.changed();
  await expect(chat.locator('[data-chat-item="layout-answer"]')).toBeVisible();
  await input.fill('$');await expect(list.getByRole('option')).toHaveCount(names.length);
  const boxes=await chat.evaluate(element=>{const box=selector=>{const r=element.querySelector(selector).getBoundingClientRect();return{x:r.x,width:r.width}};return{chat:element.getBoundingClientRect().toJSON(),composer:box('.graphical-composer'),timeline:box('.graphical-timeline'),popup:box('.graphical-skill-completion')};});
  assert.ok(boxes.composer.width<=721&&boxes.timeline.width<=721);assert.ok(boxes.composer.x-boxes.chat.x>150,'Desktop side margin');assert.ok(Math.abs(boxes.composer.width-boxes.popup.width)<2,'Menu follows entire input');
  await page.mouse.move(0,0);await chat.screenshot({path:path.join(evidence,`${agent}-wide-menu.png`)});const scrollBefore=await chat.locator('.graphical-messages').evaluate(el=>el.scrollTop);await input.press('Escape');assert.equal(await chat.locator('.graphical-messages').evaluate(el=>el.scrollTop),scrollBefore,'Closing suggestions must not scroll messages');await expect(chat.locator('[data-chat-item="layout-answer"]')).toBeInViewport();await chat.screenshot({path:path.join(evidence,`${agent}-wide-reading.png`)});
  for(const width of [390,700]){await page.setViewportSize({width,height:1000});await input.fill('');await input.fill('$');await expect(list.getByRole('option')).toHaveCount(names.length);assert.ok(await chat.evaluate(element=>element.scrollWidth<=element.clientWidth+1));const menu=await chat.locator('.graphical-skill-completion').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width+1);await chat.screenshot({path:path.join(evidence,`${agent}-${width}.png`)});await input.press('Escape');}
  await page.setViewportSize({width:1440,height:1000});
  if(agent==='claude'){await input.fill('$review $in');await expect(list.getByRole('option')).toHaveCount(2);for(const option of await list.getByRole('option').all())await expect(option).toBeDisabled();await expect(chat.locator('.graphical-skill-completion footer')).toContainText('one skill per message');await input.press('Enter');await expect(input).toHaveValue('$review $in');await input.press('Escape');}
  if(agent==='claude'){
   const image=path.join(repo,'synthetic.png');await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
   const attached=await fetch(`${service.origin}/api/sessions/${session.id}/attach`,{method:'POST',headers,body:JSON.stringify({paths:[image],runtimeId:runtime.runtimeId})});assert.ok(attached.ok,await attached.text());
   await expect(chat.getByRole('button',{name:'Inspect synthetic.png',exact:true})).toBeVisible();await input.fill('$review');await expect(list.getByRole('option')).toBeDisabled();await expect(chat.locator('.graphical-skill-completion footer')).toContainText('Remove images');await input.press('Escape');
   const detached=await fetch(`${service.origin}/api/sessions/${session.id}/chat`,{method:'POST',headers,body:JSON.stringify({action:'detach-attachment',path:image,runtimeId:runtime.runtimeId})});assert.ok(detached.ok,await detached.text());await expect(chat.getByRole('button',{name:'Inspect synthetic.png',exact:true})).toHaveCount(0);await input.fill('');
  }
  await input.fill('$review');await expect(list.getByRole('option')).toHaveCount(1);await input.press('Enter');await input.press('Enter');
  await expect.poll(()=>agent==='codex'?codex.calls.filter(call=>call.method==='turn/start').length:wires.flatMap(wire=>wire.calls).filter(call=>call.type==='user').length).toBe(1);
  if(agent==='codex')assert.ok(codex.calls.find(call=>call.method==='turn/start').params.input.some(part=>part.type==='skill'&&part.name==='review'));else assert.ok(JSON.stringify(wires.flatMap(wire=>wire.calls).find(call=>call.type==='user')).includes('/review'));
  await expect(input).toHaveValue('');let release;control.gate=new Promise(resolve=>{release=resolve;});
  try{
   const count=control.calls;await input.fill('$');await expect.poll(()=>control.calls).toBeGreaterThan(count);
   const next=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,accountProfileId:agent==='codex'?profile.id:undefined});controls.get(next.id).names=['only-new-skill'];
   await fetch(`${service.origin}/api/sessions/${next.id}/focus`,{method:'POST',headers,body:'{}'});await page.goto(service.urls.chats);await page.bringToFront();await input.fill('$');await expect(list.getByRole('option')).toHaveCount(1);await expect(list).toContainText('only-new-skill');release();control.gate=null;await page.waitForTimeout(60);await expect(list.getByRole('option')).toHaveCount(1);await expect(list).toContainText('only-new-skill');
  }finally{release?.();control.gate=null;}
  checks.push({agent,centered:true,fullInputMenu:true,nativeSkill:true,lazyCatalog:true,keyboard:true,narrow:true,staleCatalogIgnored:true});
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
}finally{await browser?.close();await service?.close();for(const wire of wires)await wire.close();await cleanupFixtures();}
