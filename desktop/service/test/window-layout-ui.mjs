// Actual Settings UI and service, with native layout events recorded only.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
const root=path.resolve('.'),index=process.argv.indexOf('--portable'),portable=index<0?null:path.resolve(process.argv[index+1]);
const {createService:factory}=await import(pathToFileURL(path.join(portable?path.join(portable,'App/runtime/service'):path.join(root,'desktop/service'),'server.mjs')));
const base=await mkdtemp(path.join(os.tmpdir(),'mik-window-share-ui-')),events=[];
let service,browser;
try{
  const repo=path.join(base,'hub');await mkdir(path.join(repo,'workspace'),{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
  service=await createService({repo,uiDir:portable?path.join(portable,'App/runtime/ui'):path.join(root,'dist'),native:event=>events.push(event),mcpOptions:{home:path.join(base,'home'),env:{}}},factory);
  browser=await chromium.launch({headless:true,channel:process.env.MRMAK_TEST_BROWSER||'chrome',env:testBrowserEnvironment()});
  const page=await browser.newPage({viewport:{width:1050,height:950}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(service.urls.workspace);await page.getByRole('button',{name:'Toggle settings',exact:true}).click();
  const section=page.getByRole('region',{name:'Window sizes',exact:true}),slider=section.getByRole('slider',{name:'Chats share of screen',exact:true});
  await expect(slider).toHaveValue('30');await expect(section).toContainText('Workspace 70%');
  await slider.focus();await slider.press('Home');for(let step=0;step<20;step++)await slider.press('ArrowRight');
  await expect(slider).toHaveValue('40');await expect(section).toContainText('Workspace 60%');assert.equal(events.filter(event=>event.type==='window').length,0);
  await section.getByRole('button',{name:'Apply window sizes',exact:true}).click();await expect.poll(()=>service.chatWidthPercent).toBe(40);await expect.poll(()=>events.filter(event=>event.type==='window').length).toBe(1);
  assert.deepEqual(events.find(event=>event.type==='window'),{type:'window',action:'layout',window:'workspace',chatWidthPercent:40});
  assert.equal(JSON.parse(await readFile(path.join(repo,'.mrmak/settings.json'),'utf8')).chatWidthPercent,40);
  await page.reload();await page.getByRole('button',{name:'Toggle settings',exact:true}).click();await expect(slider).toHaveValue('40');
  await section.getByRole('button',{name:'30 / 70',exact:true}).click();await expect(slider).toHaveValue('30');assert.equal(service.chatWidthPercent,40);
  await section.getByRole('button',{name:'Apply window sizes',exact:true}).click();await expect.poll(()=>service.chatWidthPercent).toBe(30);
  await page.goto(service.urls.chats);await page.getByRole('button',{name:'Restore default window layout',exact:true}).click();await expect.poll(()=>events.filter(event=>event.type==='window').length).toBe(3);
  assert.equal(events.filter(event=>event.type==='window').at(-1).chatWidthPercent,30);assert.equal(service.sessions.items.size,0);assert.deepEqual(errors,[]);
  console.log('PASS Settings window slider: 30/70 default, keyboard preview without movement, explicit apply, persistence/reload, reset, and native layout requests without agent activity.');
}finally{await browser?.close();await service?.close();await cleanupFixtures()}
