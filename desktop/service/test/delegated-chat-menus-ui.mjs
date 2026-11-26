// Delegated keyboard/empty-state review using real service and synthetic providers.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir,writeFile } from 'node:fs/promises';
import { chromium,expect } from '@playwright/test';
import { mkdtemp,createService,cleanupFixtures,testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
let browser,service;const wires=[],checks=[];const verify=process.argv.includes('--verify'),visual=process.argv.includes('--visual'),evidence=path.resolve('.cache',visual?'delegated-menus-final-b':verify?'delegated-menus-after':'delegated-menus-before');
try{
 const base=await mkdtemp(path.join(os.tmpdir(),'mik-delegated-menus-')),repo=path.join(base,'hub'),home=path.join(base,'home');await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await mkdir(evidence,{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}},profileOptions:{root:path.join(base,'accounts')}});service.sessions.verifyAccount=async()=>{};service.sessions.verifyIdentity=async()=>{};service.sessions.captureTools=async()=>({});
 const profile=await service.profiles.create('Synthetic menu review'),codex=graphicalFixture();
 service.sessions.createGraphicalRuntime=options=>{if(options.session.agent==='codex')return new CodexChat({...options,spawnChild:codex.spawnChild});const wire=claudeFixture(options.session.nativeId);wires.push(wire);return new ClaudeChat({...options,transportFactory:wire.factory});};
 browser=await chromium.launch({headless:true,channel:'chrome',env:testBrowserEnvironment()});const page=await browser.newPage({viewport:{width:390,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const agent of ['codex','claude']){
  const session=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,accountProfileId:agent==='codex'?profile.id:undefined}),runtime=service.sessions.get(session.id).graphical;
  const available=[{name:'fixture-review',path:path.join(repo,'fixture-review','SKILL.md'),description:'Synthetic review skill'}];let catalog=available,catalogError=false;
  runtime.composer.skills=async()=>{if(catalogError)throw new Error('Synthetic skill catalog unavailable');return{skills:catalog,warnings:''};};
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:'{}'});await page.goto(service.urls.chats);await page.bringToFront();
  const chat=page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}),trigger=chat.getByRole('combobox',{name:'Model and reasoning',exact:true});
  await expect(trigger).toBeEnabled();await trigger.focus();await trigger.press('Enter');const modelMenu=page.getByRole('dialog',{name:'Model and reasoning',exact:true}),model=modelMenu.getByRole('combobox',{name:'Model',exact:true});await expect(model).toBeFocused();
  await model.press('ArrowDown');const list=page.getByRole('listbox',{name:'Model',exact:true});await expect(list).toBeVisible();assert.ok(await list.getByRole('option').first().evaluate(el=>el===document.activeElement));await page.keyboard.press('Escape');await expect(list).toHaveCount(0);await expect(modelMenu).toBeVisible();await expect(model).toBeFocused();await page.keyboard.press('Escape');await expect(modelMenu).toHaveCount(0);await expect(trigger).toBeFocused();
  await chat.getByLabel('Chat details',{exact:true}).click();const sessionTab=chat.getByRole('tab',{name:'Session',exact:true});await sessionTab.focus();await sessionTab.press('ArrowRight');await expect(chat.getByRole('tab',{name:'Context',exact:true})).toBeFocused();await expect(chat.getByRole('tab',{name:'Context',exact:true})).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');await expect(chat.getByLabel('Chat details',{exact:true})).toBeFocused();
  await chat.getByLabel('Add context',{exact:true}).click();await chat.getByRole('button',{name:'Choose a skill',exact:true}).click();await expect(chat.getByRole('button',{name:/fixture-review/})).toBeVisible();await chat.getByRole('textbox',{name:'Find a skill',exact:true}).fill('no-matching-synthetic-skill');await expect(chat.getByRole('button',{name:/fixture-review/})).toHaveCount(0);
  const menu=chat.locator('.graphical-context-menu');const readable=await menu.innerText();const result={agent,modelKeyboard:true,detailsKeyboard:true,skillSearchHasEmptyFeedback:/no .*match|no .*found/i.test(readable)};checks.push(result);await menu.locator('.graphical-context-panel').screenshot({path:path.join(evidence,`${agent}-skill-no-match.png`)});if(verify)assert.ok(result.skillSearchHasEmptyFeedback,'A filtered skill catalog needs an explicit no-match state');
  if(verify){
   await chat.getByRole('textbox',{name:'Find a skill',exact:true}).fill('');await expect(chat.getByRole('button',{name:/fixture-review/})).toBeVisible();
   catalogError=true;await menu.getByRole('button',{name:'Refresh skills',exact:true}).click();await expect(menu.getByRole('alert')).toContainText('Synthetic skill catalog unavailable');await expect(menu.getByText('No skills match your search.',{exact:true})).toHaveCount(0);await expect(menu.getByText('No enabled skills are available for this chat.',{exact:true})).toHaveCount(0);
   catalogError=false;catalog=[];await menu.getByRole('button',{name:'Refresh skills',exact:true}).click();await expect(menu.getByText('No enabled skills are available for this chat.',{exact:true})).toBeVisible();await expect(menu.getByText('No skills match your search.',{exact:true})).toHaveCount(0);
   catalog=available;await menu.getByRole('button',{name:'Refresh skills',exact:true}).click();await expect(menu.getByRole('button',{name:/fixture-review/})).toBeVisible();result.filterRecovery=true;result.globalEmptyAndErrorStates=true;
  }
  await page.keyboard.press('Escape');await expect(chat.getByLabel('Add context',{exact:true})).toBeFocused();
  if(visual){for(const theme of ['rose','blue'])for(const size of [{width:320,height:520},{width:1000,height:900}]){
   await page.setViewportSize(size);const changed=await fetch(`${service.origin}/api/settings`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({accentTheme:theme})});assert.ok(changed.ok);await page.waitForFunction(theme=>document.documentElement.dataset.accentTheme===theme,theme);
   const bounded=async node=>{const rect=await node.boundingBox();assert.ok(rect&&rect.x>=0&&rect.y>=0&&rect.x+rect.width<=size.width+1&&rect.y+rect.height<=size.height+1,JSON.stringify({theme,size,rect}));};
   await trigger.click();await expect(modelMenu).toBeVisible();await bounded(modelMenu);await modelMenu.screenshot({path:path.join(evidence,`${agent}-${theme}-${size.width}-model.png`)});await page.keyboard.press('Escape');
   await chat.getByLabel('Chat details',{exact:true}).click();await chat.getByRole('tab',{name:'Actions',exact:true}).click();const details=chat.locator('.graphical-info-panel');await bounded(details);await details.screenshot({path:path.join(evidence,`${agent}-${theme}-${size.width}-details.png`)});const archive=details.getByRole('button',{name:'Archive chat',exact:true});await archive.focus();await bounded(archive);await details.screenshot({path:path.join(evidence,`${agent}-${theme}-${size.width}-details-end.png`)});await page.keyboard.press('Escape');
   await chat.getByLabel('Add context',{exact:true}).click();await chat.getByRole('button',{name:'Choose a skill',exact:true}).click();await chat.getByRole('textbox',{name:'Find a skill',exact:true}).fill('no-matching-synthetic-skill');await expect(menu.getByText('No skills match your search.',{exact:true})).toBeVisible();const panel=menu.locator('.graphical-context-panel');await bounded(panel);await panel.screenshot({path:path.join(evidence,`${agent}-${theme}-${size.width}-skills.png`)});await page.keyboard.press('Escape');
  }result.visualBounds=true;result.themes=['rose','blue'];}
 }
 assert.deepEqual(errors,[]);assert.ok(!codex.calls.some(call=>call.method==='turn/start'));assert.ok(wires.every(w=>!w.calls.some(call=>call.type==='user')));await writeFile(path.join(evidence,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
}finally{await browser?.close();await service?.close();for(const wire of wires)await wire.close();await cleanupFixtures();}
