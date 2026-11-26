// Settings acceptance uses temporary Hubs and account registries, never real sign-ins.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {mkdtemp,createService,cleanupFixtures,testBrowserEnvironment} from './fixtures.mjs';
import {seedWorkspaceFiles} from './workspace-files-ui.mjs';
import {selectControl} from './select-control.mjs';

export async function seedSettings(fixture){
 for(let i=1;i<=6;i++)await fixture.request('/accounts/profiles',{action:'create',label:'Fixture account '+i});
 for(let i=1;i<=4;i++)await fixture.request('/accounts/claude-profiles',{action:'create',label:'Claude fixture '+i});
}
export async function exerciseSettings(page,fixture){
 page.setDefaultTimeout(15000);await page.setViewportSize({width:1100,height:850});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'Toggle settings',exact:true}).click();
 await expect(page.locator('.settings-category')).toHaveCount(5);
 await page.getByRole('button',{name:'Appearance settings',exact:true}).click();
 let details=page.getByRole('dialog',{name:'Appearance settings',exact:true});
 assert.ok(Math.abs((await details.boundingBox()).width-340)<1);
 const slider=details.getByRole('slider',{name:'Chats share of screen',exact:true});assert.ok((await slider.boundingBox()).width<=131);
 await slider.fill('40');await details.getByRole('button',{name:'Apply window sizes',exact:true}).click();
 await expect(slider).toHaveValue('40');await details.getByRole('button',{name:'Reset to 30 / 70',exact:true}).click();await expect(slider).toHaveValue('30');
 await page.screenshot({path:'.cache/settings-implemented-appearance.png'});
 await page.getByRole('button',{name:'Chats settings',exact:true}).click();
 details=page.getByRole('dialog',{name:'Chats settings',exact:true});
 await details.getByRole('group',{name:'Default provider'}).getByRole('button',{name:'Claude',exact:true}).click();
 await selectControl(page,'Claude permissions','bypass');await expect(details.getByRole('combobox',{name:'Claude permissions',exact:true})).toContainText('Bypass');
 await expect(details.getByRole('combobox',{name:'Coordinator reasoning',exact:true})).toBeVisible();
 await page.screenshot({path:'.cache/settings-implemented-chats.png'});
 await page.getByRole('button',{name:'Accounts settings',exact:true}).click();
 details=page.getByRole('dialog',{name:'Accounts settings',exact:true});
 const codex=details.getByRole('region',{name:'Codex account profiles',exact:true});
 try { await expect(codex.getByRole('button',{name:'Fixture account 1',exact:true})).toBeVisible(); } catch(error) { console.error('Settings diagnostics:',await page.locator('body').innerText());await page.screenshot({path:'.cache/settings-failure.png'});throw error }
 assert.ok(await codex.locator('.account-profile-list').evaluate(el=>el.scrollHeight>el.clientHeight&&el.clientHeight<=200));
 await codex.getByRole('button',{name:'Fixture account 1',exact:true}).click();
 let name=codex.getByRole('textbox',{name:'Account name',exact:true});await name.fill('Cancelled name');await name.press('Escape');
 await expect(codex.getByRole('button',{name:'Fixture account 1',exact:true})).toBeVisible();
 await codex.getByRole('button',{name:'Fixture account 1',exact:true}).click();name=codex.getByRole('textbox',{name:'Account name',exact:true});await name.fill('Renamed fixture');await name.press('Enter');
 await expect(codex.getByRole('button',{name:'Renamed fixture',exact:true})).toBeVisible();
 if(!fixture.native){
  const reject=route=>route.request().method()==='POST'&&route.request().postDataJSON()?.action==='rename'?route.fulfill({status:409,json:{error:'Synthetic rename conflict'}}):route.continue();
  await page.route('**/api/accounts/profiles',reject);
  try{
   await codex.getByRole('button',{name:'Renamed fixture',exact:true}).click();name=codex.getByRole('textbox',{name:'Account name',exact:true});await name.fill('Retained draft');await name.press('Enter');
   await expect(codex.getByRole('alert')).toContainText('Synthetic rename conflict');await expect(name).toHaveValue('Retained draft');await name.press('Escape');
   await expect(codex.getByRole('button',{name:'Renamed fixture',exact:true})).toBeVisible();
  }finally{await page.unroute('**/api/accounts/profiles',reject)}
 }
 await details.getByRole('group',{name:'Account provider'}).getByRole('button',{name:'Claude',exact:true}).click();
 const claude=details.getByRole('region',{name:'Claude account profiles',exact:true});await expect(claude.getByRole('button',{name:'Claude fixture 1',exact:true})).toBeVisible();
 await page.screenshot({path:'.cache/settings-implemented-accounts.png'});
 await claude.getByRole('button',{name:'Add Claude account',exact:true}).click();await expect(page.getByRole('dialog',{name:'Add Claude account',exact:true})).toBeVisible();if(!fixture.native){
  const reject=route=>route.request().method()==='POST'&&route.request().postDataJSON()?.action==='create'?route.fulfill({status:409,json:{error:'Synthetic Claude directory unavailable'}}):route.continue();
  await page.route('**/api/accounts/claude-profiles',reject);
  try { const add=page.getByRole('dialog',{name:'Add Claude account',exact:true});await add.getByRole('textbox',{name:'Claude account name',exact:true}).fill('Retained Claude draft');await add.getByRole('button',{name:'Create and sign in',exact:true}).click();await expect(add.getByRole('alert')).toContainText('Synthetic Claude directory unavailable');await expect(add.getByRole('textbox',{name:'Claude account name',exact:true})).toHaveValue('Retained Claude draft'); }
  finally { await page.unroute('**/api/accounts/claude-profiles',reject) }
 }
 await page.getByRole('dialog',{name:'Add Claude account',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Transfer Hub settings',exact:true}).click();await expect(page.getByRole('button',{name:'Export · full',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Choose archive to import…',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Workspace snapshots settings',exact:true}).click();await expect(page.getByRole('button',{name:'Import snapshot…',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close settings details',exact:true}).click();
 for(const width of [740,580,360,320]){await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'Appearance settings',exact:true}).click();const box=await page.getByRole('dialog',{name:'Appearance settings',exact:true}).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);await page.getByRole('button',{name:'Close settings details',exact:true}).click()}
 if(fixture.native){
  await fixture.request('/settings',{accentTheme:'blue'});await expect(page.locator('html')).toHaveAttribute('data-accent-theme','blue');
  await page.setViewportSize({width:1100,height:850});await page.getByRole('button',{name:'Appearance settings',exact:true}).click();
  await expect(page.getByRole('button',{name:'Appearance settings',exact:true})).toHaveCSS('border-left-color','rgb(131, 197, 255)');
  const nativePalette=await page.evaluate(()=>{const popup=document.querySelector('[data-menu-owner=settings-details]');return [getComputedStyle(popup).backgroundColor,getComputedStyle(document.querySelector('.hub-rail-content')).backgroundColor]});assert.equal(nativePalette[0],nativePalette[1]);
  await page.screenshot({path:'.cache/theme-native-blue.png'});await page.getByRole('button',{name:'Close settings details',exact:true}).click();
 }
 assert.deepEqual(errors,[]);
}
if(process.argv.includes('--run')&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let browser;
 try{
  const base=await mkdtemp(path.join(os.tmpdir(),'mik-settings-ui-')),repo=path.join(base,'Hub');for(const folder of ['workspace','context','knowledge','processes','inbox'])await mkdir(path.join(repo,folder),{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
  const service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home:path.join(base,'home'),env:{}}});const fixture=await seedWorkspaceFiles(service,repo,base);
  fixture.request=async(route,data)=>{const response=await fetch(service.origin+'/api'+route,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();assert.ok(response.ok,value.error);return value};await seedSettings(fixture);
  browser=await chromium.launch({channel:'msedge',headless:true,env:testBrowserEnvironment()});const page=await browser.newPage();await page.goto(service.urls.workspace);await exerciseSettings(page,fixture);console.log('PASS Settings UI: compact categories, independent defaults, inline rename, bounded account list, native dialogs and 320-1100px geometry.');
 }finally{await browser?.close();await cleanupFixtures()}
}
