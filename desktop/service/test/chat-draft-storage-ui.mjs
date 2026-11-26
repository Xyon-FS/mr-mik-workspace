// Storage failures must not disable editing or server-side draft persistence.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {mkdtemp,createService,cleanupFixtures,testBrowserEnvironment} from './fixtures.mjs';
import {CodexChat} from '../codex-chat.mjs';
import {ClaudeChat} from '../claude-chat.mjs';
import {graphicalFixture} from './codex-chat-fixture.mjs';
import {claudeFixture} from './claude-chat-fixture.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'mik-draft-storage-'));let service,browser;const wires=[];
try{
 const repo=path.join(root,'hub'),home=path.join(root,'home');await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}}});
 const profile=await service.profiles.create('Storage fixture');
 service.sessions.verifyAccount=async()=>{};service.sessions.verifyIdentity=async()=>{};service.sessions.captureTools=async()=>({});service.sessions.prepareLaunch=async()=>null;service.sessions.prepareBrowser=async()=>null;
 service.sessions.createGraphicalRuntime=options=>{if(options.session.agent==='codex'){const wire=graphicalFixture();return new CodexChat({...options,spawnChild:wire.spawnChild});}const wire=claudeFixture(options.session.nativeId);wires.push(wire);return new ClaudeChat({...options,transportFactory:wire.factory});};
 browser=await chromium.launch({headless:true,channel:'msedge',env:testBrowserEnvironment()});
 for(const deniedReads of [false,true]){
  const context=await browser.newContext();await context.addInitScript(deny=>{
   const read=Storage.prototype.getItem,write=Storage.prototype.setItem;
   window.seedDraftStorage=(key,value)=>write.call(localStorage,key,value);
   Storage.prototype.getItem=function(key){if(deny&&String(key).startsWith('mrmak.chat-draft.'))throw new DOMException('Synthetic disabled storage','SecurityError');return read.call(this,key);};
   Storage.prototype.setItem=function(key,value){if(String(key).startsWith('mrmak.chat-draft.'))throw new DOMException('Synthetic quota','QuotaExceededError');return write.call(this,key,value);};
  },deniedReads);
  try{const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   for(const agent of ['codex','claude']){
    const created=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,...(agent==='codex'?{accountProfileId:profile.id}:{})});
    const runtime=service.sessions.get(created.id).graphical;runtime.draft='Saved native draft';runtime.changed();
    await fetch(service.origin+`/api/sessions/${created.id}/focus`,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{}'});
    await page.goto(service.urls.chats);const input=page.getByRole('textbox',{name:`Message ${agent==='codex'?'Codex':'Claude'}`,exact:true});
    await expect(input).toHaveValue('Saved native draft');await input.fill('New draft survives unavailable storage');
    await expect.poll(()=>runtime.draft).toBe('New draft survives unavailable storage');runtime.changed();await page.waitForTimeout(350);await expect(input).toHaveValue('New draft survives unavailable storage');
    if(!deniedReads){
     await page.evaluate(id=>window.seedDraftStorage(`mrmak.chat-draft.${id}`,'Obsolete cached text'),created.id);
     await input.fill('Newest native draft after cache failure');await expect.poll(()=>runtime.draft).toBe('Newest native draft after cache failure');
     await page.reload();await expect(input).toHaveValue('Newest native draft after cache failure');
    }
    await service.sessions.remove(created.id);
   }
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log('PASS Codex/Claude: disabled or full local draft storage retains editable drafts and native persistence without UI errors.');
}finally{await browser?.close();await service?.close();for(const wire of wires)wire.close();await cleanupFixtures();}
