// Delegated review: stop remains reachable while drafting; isolated providers.
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

const verify=process.argv.includes('--verify'), evidence=path.resolve('.cache',verify?'delegated-stop-after':'delegated-stop-before');
let browser,service;const wires=[],checks=[];
try{
 const base=await mkdtemp(path.join(os.tmpdir(),'mik-delegated-stop-')),repo=path.join(base,'hub'),home=path.join(base,'home');
 await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await mkdir(evidence,{recursive:true});
 await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}},profileOptions:{root:path.join(base,'accounts')}});
 service.sessions.verifyAccount=async()=>{};service.sessions.verifyIdentity=async()=>{};service.sessions.captureTools=async()=>({});
 const profile=await service.profiles.create('Synthetic stop review'),codex=graphicalFixture({approval:true});
 service.sessions.createGraphicalRuntime=options=>{if(options.session.agent==='codex')return new CodexChat({...options,spawnChild:codex.spawnChild});const wire=claudeFixture(options.session.nativeId,{holdSteerResult:true});wires.push(wire);return new ClaudeChat({...options,transportFactory:wire.factory});};
 browser=await chromium.launch({headless:true,channel:'chrome',env:testBrowserEnvironment()});const page=await browser.newPage({viewport:{width:480,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const agent of ['codex','claude']){
  const session=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,accountProfileId:agent==='codex'?profile.id:undefined});
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:'{}'});
  await page.goto(service.urls.chats);const chat=page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}),draft=chat.getByRole('textbox',{name:agent==='codex'?'Message Codex':'Message Claude',exact:true});
  await draft.fill('slow');await chat.getByRole('button',{name:'Send message',exact:true}).click();
  const stop=chat.getByRole('button',{name:'Interrupt response',exact:true});await expect(stop).toBeEnabled();
  await draft.fill('Keep this unsent draft while stopping');
  const runtime=service.sessions.get(session.id).graphical,source=runtime.snapshot().items.find(item=>item.type==='userMessage');
  const quoted=await fetch(`${service.origin}/api/sessions/${session.id}/chat`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'composer-add',runtimeId:runtime.runtimeId,context:{type:'quote',itemId:source.id,text:source.text}})});assert.ok(quoted.ok,await quoted.text());
  await expect(chat.getByRole('button',{name:'Remove quote',exact:true})).toBeVisible();
  await expect(draft).toHaveValue('Keep this unsent draft while stopping');
  const result={agent,stopAvailable:await stop.count()===1,sendAvailable:await chat.getByRole('button',{name:'Send message',exact:true}).count()===1};checks.push(result);
  await chat.screenshot({path:path.join(evidence,`${agent}-draft-working.png`)});
  await draft.press('Control+f');const search=chat.getByRole('textbox',{name:'Search conversation',exact:true});await expect(search).toBeFocused();await search.press('Escape');await expect(search).toHaveCount(0);
  result.searchCloseRestoresDraftFocus=await draft.evaluate(el=>el===document.activeElement);
  result.focusAfterSearchClose=await page.evaluate(()=>document.activeElement?.tagName);
  for(const width of [320,390,480]){await page.setViewportSize({width,height:900});await chat.screenshot({path:path.join(evidence,`${agent}-draft-working-${width}.png`)});assert.ok(await chat.evaluate(el=>el.scrollWidth<=el.clientWidth+1));if(verify){const rect=await stop.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=width&&rect.y+rect.height<=900,JSON.stringify(rect));}}
  if(verify){assert.ok(result.stopAvailable,'Working chat must remain stoppable without clearing its draft');assert.ok(result.searchCloseRestoresDraftFocus,'Search Escape returns to the unsent draft');await stop.focus();await stop.press('Enter');await expect(draft).toHaveValue('Keep this unsent draft while stopping');await expect(chat.getByRole('button',{name:'Remove quote',exact:true})).toBeVisible();await expect(stop).toHaveCount(0);assert.equal(agent==='codex'?codex.calls.filter(call=>call.method==='turn/start').length:wires.at(-1).calls.filter(call=>call.type==='user').length,1);}
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
}finally{await browser?.close();await service?.close();for(const wire of wires)await wire.close();await cleanupFixtures();}
