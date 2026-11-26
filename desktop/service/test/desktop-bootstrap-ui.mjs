// Real compiled entrypoint: bootstrap retry and strict-mode single startup.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';

const base=await mkdtemp(path.join(os.tmpdir(),'mik-bootstrap-ui-'));
let browser,service;
try {
 const repo=path.join(base,'hub'),home=path.join(base,'home');await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
 service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude')}},profileOptions:{root:path.join(base,'accounts')}});
 browser=await chromium.launch({headless:true,channel:'chrome',env:testBrowserEnvironment()});
 for(const surface of ['chats','workspace']) {
  const page=await browser.newPage(),errors=[];let calls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/bootstrap',route=>{calls++;return calls===1?route.abort('failed'):route.continue()});
  await page.goto(service.urls[surface]);
  await expect(page.getByRole('button',{name:'Reconnect',exact:true})).toBeVisible();
  assert.equal(calls,1,'Failed entrypoint bootstrap is not silently retried by mount');
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();
  await expect(page.locator('.desktop-root')).toBeVisible();
  assert.equal(calls,2,'Explicit recovery starts one bootstrap');
  await page.waitForTimeout(150);assert.equal(calls,2,'No duplicate StrictMode bootstrap');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS both desktop surfaces: early bootstrap, explicit failure recovery and one request per startup/retry; isolated Hub, zero model calls.');
}finally{await browser?.close();await service?.close();await cleanupFixtures();}
