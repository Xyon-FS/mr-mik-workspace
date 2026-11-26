// Offline handbook and shared-themed presentation against a disposable Hub.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,writeFile,cp} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {mkdtemp,createService,cleanupFixtures,testBrowserEnvironment} from './fixtures.mjs';
const root=path.resolve('.'),base=await mkdtemp(path.join(os.tmpdir(),'mik-guide-ui-'));
let service,browser;
try{
 const repo=path.join(base,'hub');await mkdir(path.join(repo,'workspace'),{recursive:true});await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
 await cp(path.join(root,'public/assets'),path.join(root,'dist/assets'),{recursive:true});
 service=await createService({repo,uiDir:path.join(root,'dist'),mcpOptions:{home:path.join(base,'home'),env:{}}});
 browser=await chromium.launch({channel:'msedge',headless:true,env:testBrowserEnvironment()});const page=await browser.newPage({viewport:{width:1280,height:940}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(service.urls.workspace);const launch=page.getByRole('button',{name:'Open Workspace help',exact:true});await launch.click();
 const guide=page.getByRole('dialog',{name:'Mr. Mik guide',exact:true}),content=guide.locator('.help-site-content');
 await expect(guide).toBeVisible();await expect(guide.getByRole('textbox',{name:'Search the guide'})).toBeFocused();
 await expect(guide.locator('.help-site-nav-list section')).toHaveCount(5);
 await expect(guide.getByRole('heading',{name:'Mr. Mik Workspace · Manual and reference'})).toBeVisible();
 await content.getByRole('link',{name:'Settings and transfer',exact:true}).click();await expect(content.getByRole('heading',{name:'Settings and transferring a Hub',exact:true})).toBeVisible();await expect(content).toContainText('Logged in is green');
 await guide.locator('.help-site-nav-list').getByRole('button',{name:'Chats and working folders',exact:true}).click();await expect(content).toContainText('History is a single icon at the bottom');await expect(content).not.toContainText('27%');
 const search=guide.getByRole('textbox',{name:'Search the guide'});await search.fill('Coordinator reasoning');await expect(content).toContainText('Coordinator reasoning');await expect(guide.locator('.help-site-nav-list button')).not.toHaveCount(0);
 await search.fill('fixture-unmatched-query');await expect(guide.getByRole('status')).toContainText('No sections match');await guide.getByRole('button',{name:'Clear guide search'}).click();await expect(guide.locator('.help-site-nav-list section')).toHaveCount(5);
 await guide.locator('.help-site-nav-list').getByRole('button',{name:'Skills: Hub and linked project',exact:true}).click();await expect(content).toContainText('Inherit');
 await page.screenshot({path:path.join(root,'.cache/workspace-guide-desktop.png')});
 const colours=[];
 for(const theme of ['rose','violet','blue','teal']){await page.evaluate(theme=>{document.documentElement.dataset.accentTheme=theme},theme);colours.push(await guide.evaluate(el=>getComputedStyle(el).backgroundColor));await expect(guide).toBeVisible();}
 assert.equal(new Set(colours).size,4,'Guide surface follows every app theme');
 for(const width of [740,480,390,320]){await page.setViewportSize({width,height:850});assert.ok(await guide.evaluate(el=>{const box=el.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&el.scrollWidth<=el.clientWidth+1}),'Guide fits '+width);assert.ok(await content.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Reader fits '+width);await search.fill('MCP');await expect(guide.locator('.help-site-nav-list button').first()).toBeVisible();await search.fill('');}
 await page.screenshot({path:path.join(root,'.cache/workspace-guide-mobile.png')});
 await guide.getByRole('button',{name:'Close guide'}).focus();await page.keyboard.press('Tab');assert.ok(await guide.evaluate(el=>el.contains(document.activeElement)),'Native guide traps focus');
 await page.keyboard.press('Escape');await expect(guide).toHaveCount(0);await expect(launch).toBeFocused();assert.deepEqual(errors,[]);
 console.log('PASS offline guide: grouped index, source completeness, internal links, search/no-results/clear, native focus/Escape, all themes and 320–1280px layouts.');
}finally{await browser?.close();await cleanupFixtures()}
