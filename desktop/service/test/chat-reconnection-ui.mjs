// Restoration UI against stopped synthetic sessions, without real native starts.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {mkdtemp,createService,cleanupFixtures,testBrowserEnvironment} from './fixtures.mjs';
const base=await mkdtemp(path.join(os.tmpdir(),'mik-reconnection-ui-'));let browser,service;
try{
 const repo=path.join(base,'hub');await mkdir(path.join(repo,'workspace'),{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home:path.join(base,'home'),env:{}}});
 browser=await chromium.launch({headless:true,channel:'msedge',env:testBrowserEnvironment()});const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const agent of ['codex','claude']){
  const session=service.sessions.make({id:randomUUID(),agent,accountProfileId:'fixture',chatInterface:'chat',cwd:repo,name:agent+' restore',open:true,status:'stopped',nativeId:randomUUID(),cols:90,rows:32,createdAt:new Date().toISOString()});service.sessions.items.set(session.id,session);service.sessions.changed(session);
  await fetch(service.origin+'/api/sessions/'+session.id+'/focus',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{}'});await page.goto(service.urls.chats);
  await expect(page.locator('.terminal-reconnect')).toContainText('Reconnecting to your conversation');await expect(page.locator('.terminal-reconnect')).toHaveCount(1);await expect(page.locator('.graphical-transport-error,.graphical-error')).toHaveCount(0);await expect(page.locator('.chat-status')).not.toContainText(/Reconnecting|Starting/);
  await page.waitForTimeout(1600);await expect(page.locator('.graphical-transport-error,.graphical-error')).toHaveCount(0);
  const input=page.getByRole('textbox',{name:agent==='codex'?'Message Codex':'Message Claude',exact:true});await input.fill('Retained restore draft');
  session.status='starting';service.sessions.changed(session);await expect(page.getByRole('status').filter({hasText:'Preparing'})).toHaveCount(1);await expect(page.locator('.terminal-reconnect')).toHaveCount(0);await expect(input).toHaveValue('Retained restore draft');
  session.status='stopped';session.restoreError='Synthetic account requires reconnect';service.sessions.changed(session);await expect(page.getByText('Synthetic account requires reconnect',{exact:true})).toHaveCount(1);await expect(page.locator('.graphical-error')).toHaveCount(0);await expect(input).toHaveValue('Retained restore draft');
  await page.screenshot({path:path.resolve('.cache/'+agent+'-reconnection-single.png')});session.open=false;service.sessions.changed(session);
 }
 assert.deepEqual(errors,[]);console.log('PASS one reconnect notice for stopped/failed restore, one Preparing status during start, retained local drafts and no duplicated transport errors for Codex/Claude.');
}finally{await browser?.close();await cleanupFixtures()}
