// Tools concept against real APIs and disposable files; no native model/account calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { seedWorkspaceFiles } from './workspace-files-ui.mjs';
import { selectControl } from './select-control.mjs';

export async function seedTools(fixture) {
  const {project,linked}=fixture;
  await mkdir(path.join(linked.repositoryPath,'.claude'),{recursive:true});
  await writeFile(path.join(linked.repositoryPath,'.claude/settings.json'),JSON.stringify({enabledPlugins:{'project-fixture@local':true}}));
  await fixture.request('/codex/mcp-managed',{profileId:'system',scope:'project',projectId:project.id,repositoryId:linked.id,action:'save',name:'Unity_fixture',transport:'http',url:'http://127.0.0.1:1/mcp',enabled:true});
  await writeFile(path.join(linked.repositoryPath,'.mcp.json'),JSON.stringify({mcpServers:{external_fixture:{type:'http',url:'http://127.0.0.1:1/mcp',headers:{Authorization:'synthetic-private-fixture'}}}}));
  await fixture.request('/claude/mcp-managed',{profileId:'system',scope:'local',projectId:project.id,repositoryId:linked.id,action:'override',name:'external_fixture',enabled:true});
}

export async function exerciseTools(page,fixture) {
  page.setDefaultTimeout(12000);await page.setViewportSize({width:1100,height:850});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:'Toggle mcp',exact:true}).click();
  await selectControl(page,'Active workspace',fixture.project.id);
  await selectControl(page,'Linked project for tools',fixture.linked.id);
  const row=page.locator('[data-mcp-id="codex:Unity_fixture"]');await expect(row).toBeVisible();
  await expect(page.getByRole('button',{name:'Availability for Unity_fixture',exact:true})).toContainText('On');
  await expect(page.getByRole('button',{name:'Check Unity_fixture for Codex',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Hide Unity_fixture in Tools',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Check availability for Browser',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Hide Browser in Tools',exact:true})).toBeDisabled();
  const plugin=page.locator('[data-tool-id="plugin:project-fixture@local"]');
  await expect(plugin.getByRole('button',{name:'Availability for project-fixture',exact:true})).toContainText('On');
  await expect(plugin.locator('.tools-inheritance-dot')).toHaveAttribute('data-inherited','false');
  await plugin.getByRole('button',{name:'Availability for project-fixture',exact:true}).click();
  await selectControl(page,'project-fixture project Claude setting','off');
  await expect(plugin.getByRole('button',{name:'Availability for project-fixture',exact:true})).toContainText('Off');
  await selectControl(page,'project-fixture project Claude setting','inherit');
  await expect(plugin.getByRole('button',{name:'Availability for project-fixture',exact:true})).toContainText('On');
  await expect(plugin.locator('.tools-inheritance-dot')).toHaveAttribute('data-inherited','false');
  await page.keyboard.press('Escape');
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.linked.repositoryPath,'.claude/settings.json'),'utf8')),{enabledPlugins:{'project-fixture@local':true}});
  const columns=await page.locator('.tools-entry-controls').evaluateAll(rows=>rows.map(row=>Array.from(row.children).map(button=>Math.round(button.getBoundingClientRect().left))));
  for(const entry of columns)assert.deepEqual(entry,columns[0],'Three aligned control columns, including disabled controls');
  await expect(row.locator('.tools-inheritance-dot')).toHaveAttribute('data-inherited','false');
  await expect(page.locator('[data-mcp-id="claude:external_fixture"] .tools-inheritance-dot')).toHaveAttribute('data-inherited','false');
  const browserDot=page.getByRole('button',{name:'Availability for Browser',exact:true}).locator('.tools-inheritance-dot');
  await expect(browserDot).toHaveAttribute('data-inherited','true');
  assert.equal(await browserDot.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await row.hover();
  await expect.poll(()=>row.locator('.tools-entry').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({path:'.cache/tools-implemented-list.png'});
  await page.getByRole('button',{name:'Availability for Unity_fixture',exact:true}).click();
  const availability=page.getByRole('dialog',{name:'Availability for Unity_fixture',exact:true});
  assert.ok((await availability.boundingBox()).height<125,'Availability is a compact two-row popup');
  await page.screenshot({path:'.cache/tools-implemented-availability.png'});
  await selectControl(page,'Unity_fixture project setting','false');
  await expect(page.getByRole('group',{name:'Unity_fixture project setting',exact:true})).toHaveAttribute('data-value','false');
  await expect(page.getByRole('button',{name:'Availability for Unity_fixture',exact:true})).toContainText('Off');
  await selectControl(page,'Unity_fixture project setting','true');
  await expect(page.getByRole('group',{name:'Unity_fixture project setting',exact:true})).toHaveAttribute('data-value','true');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Details for Unity_fixture',exact:true}).click();
  let detail=page.getByRole('dialog',{name:'Details for Unity_fixture',exact:true});
  await expect(detail.getByRole('heading',{name:'Unity_fixture',exact:true})).toBeVisible();
  await expect(detail.getByRole('button',{name:'Hide Unity_fixture in Tools',exact:true})).toHaveCount(0);
  await expect(detail.getByRole('button',{name:'Check Unity_fixture for Codex'})).toHaveCount(0);
  await detail.locator('summary').filter({hasText:'Configuration'}).click();
  await expect(detail.getByRole('button',{name:'Edit definition',exact:true})).toBeVisible();
  await page.screenshot({path:'.cache/tools-implemented-details.png'});
  await detail.getByRole('button',{name:'Edit definition',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'Add MCP server',exact:true});
  await expect(editor).toBeVisible();await expect(editor.getByLabel('Server name',{exact:true})).toHaveValue('Unity_fixture');
  await expect(editor.getByLabel('MCP URL',{exact:true})).toHaveValue('');
  await selectControl(page,'Codex MCP transport','stdio');
  await expect(editor.getByLabel('Command',{exact:true})).toBeVisible();
  await page.screenshot({path:'.cache/tools-implemented-editor.png'});
  await editor.getByRole('button',{name:'Close MCP editor',exact:true}).click();
  await page.getByRole('button',{name:'Details for external_fixture',exact:true}).click();
  detail=page.getByRole('dialog',{name:'Details for external_fixture',exact:true});
  await detail.locator('summary').filter({hasText:'Configuration'}).click();
  await expect(detail.getByRole('button',{name:'Edit definition',exact:true})).toHaveCount(0);
  assert.equal((await detail.innerText()).includes('synthetic-private-fixture'),false);
  await page.getByRole('button',{name:'Hide external_fixture in Tools',exact:true}).click();
  await expect(page.getByRole('button',{name:'Details for external_fixture',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Tool filters',exact:true}).click();
  await page.getByLabel('Show hidden tools',{exact:true}).check();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Details for external_fixture',exact:true}).click();
  await page.getByRole('button',{name:'Show external_fixture in Tools',exact:true}).click();
  await page.getByRole('button',{name:'Details for Browser',exact:true}).click();
  const browser=page.getByRole('dialog',{name:'Details for Browser',exact:true});
  await browser.locator('summary').filter({hasText:'Advanced'}).click();
  await selectControl(page,'Browser engine','msedge');
  await expect(browser).toBeVisible();
  await expect(browser.getByRole('combobox',{name:'Browser engine',exact:true})).toContainText('Microsoft Edge');
  await page.screenshot({path:'.cache/tools-implemented-browser.png'});
  await browser.getByRole('button',{name:'Close tool details',exact:true}).click();
  await page.getByRole('button',{name:'Diagnostics',exact:false}).click();
  await expect(page.getByRole('dialog',{name:'Tools diagnostics',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close diagnostics',exact:true}).click();
  for(const width of [740,580,360,320]){
    await page.setViewportSize({width,height:900});
    assert.ok(await page.locator('.tools-entry').evaluateAll(rows=>rows.every(row=>row.scrollWidth<=row.clientWidth+1)),'Row controls and labels fit at '+width);
    await page.getByRole('button',{name:'Details for Unity_fixture',exact:true}).click();
    const bounds=await page.getByRole('dialog',{name:'Details for Unity_fixture',exact:true}).boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'Tool popup fits at '+width);
    await page.getByRole('button',{name:'Close tool details',exact:true}).click();
  }
  // Never leave the previous folder's tools actionable while the next inventory loads.
  if(!fixture.native) {
    let release;const gate=new Promise(resolve=>{release=resolve});
    const pending=async route=>{const url=new URL(route.request().url());if(route.request().method()==='GET'&&url.searchParams.get('repositoryId')==='primary')await gate;await route.continue()};
    await page.route('**/api/**',pending);
    try {
      await page.setViewportSize({width:1100,height:850});
      await selectControl(page,'Linked project for tools','primary');
      await expect(row).toHaveCount(0,{timeout:1500});
      await expect(page.getByRole('button',{name:'Availability for Unity_fixture',exact:true})).toHaveCount(0);
    } finally {release();await page.unrouteAll({behavior:'wait'})}
    await selectControl(page,'Linked project for tools',fixture.linked.id);await expect(row).toBeVisible();
  }
  // A delayed check from the previous folder must refresh the current context.
  if(!fixture.native) {
    let release;const gate=new Promise(resolve=>{release=resolve});
    await page.route('**/api/mcp/check',async route=>{await gate;await route.fulfill({status:200,contentType:'application/json',body:'{}'})});
    try {
      await page.setViewportSize({width:1100,height:850});
      await page.getByRole('button',{name:'Check Unity_fixture for Codex',exact:true}).click();
      await selectControl(page,'Linked project for tools','primary');
      await expect(row).toHaveCount(0);
      const refreshed=page.waitForResponse(response=>response.url().includes('/api/mcp?')&&new URL(response.url()).searchParams.get('repositoryId')==='primary');
      release();await refreshed;await expect(row).toHaveCount(0);
    } finally {release();await page.unroute('**/api/mcp/check')}
    await selectControl(page,'Linked project for tools',fixture.linked.id);await expect(row).toBeVisible();
  }
  await page.getByRole('button',{name:'Details for Unity_fixture',exact:true}).click();
  detail=page.getByRole('dialog',{name:'Details for Unity_fixture',exact:true});
  await detail.locator('summary').filter({hasText:'Configuration'}).click();
  await detail.getByRole('button',{name:'Remove definition',exact:true}).click();
  let removal=page.getByRole('alertdialog',{name:'Remove MCP definition?',exact:true});
  await removal.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(row).toBeVisible();
  if(!fixture.native) {
    await detail.getByRole('button',{name:'Remove definition',exact:true}).click();
    const failRemove=route=>route.request().method()==='POST'&&route.request().postDataJSON()?.action==='remove'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic configuration conflict'})}):route.continue();
    await page.route('**/api/codex/mcp-managed',failRemove);
    try {
      await removal.getByRole('button',{name:'Remove definition',exact:true}).click();
      await expect(removal.getByRole('alert')).toContainText('Synthetic configuration conflict');
      await expect(row).toBeVisible();
      await removal.getByRole('button',{name:'Cancel',exact:true}).click();
    } finally {await page.unroute('**/api/codex/mcp-managed',failRemove)}
  }
  await detail.getByRole('button',{name:'Remove definition',exact:true}).click();
  const removed=page.waitForResponse(response=>response.url().endsWith('/api/codex/mcp-managed')&&response.request().postDataJSON()?.action==='remove');
  await removal.getByRole('button',{name:'Remove definition',exact:true}).click();
  const removedResponse=await removed;assert.ok(removedResponse.ok(),await removedResponse.text());
  try { await expect(row).toHaveCount(0,{timeout:20000}); } catch(error) { await page.screenshot({path:'.cache/tools-removal-failure.png'});console.error('Removal UI',await page.locator('body').innerText());throw error; }
  await page.setViewportSize({width:1100,height:850});
  await page.getByRole('button',{name:'Add MCP server',exact:true}).click();
  const add=page.getByRole('dialog',{name:'Add MCP server',exact:true});
  await add.getByRole('group',{name:'MCP agent',exact:true}).getByRole('button',{name:'OpenCode',exact:true}).click();
  await selectControl(page,'MCP configuration scope','project');
  await add.getByLabel('Server name',{exact:true}).fill('opencode_fixture');
  await expect(add.getByRole('heading',{name:'Add MCP server',exact:true})).toBeVisible();
  await selectControl(page,'OpenCode MCP transport','http');
  await add.getByLabel('MCP URL',{exact:true}).fill('http://127.0.0.1:1/mcp');
  await add.getByRole('button',{name:'Save definition',exact:true}).click();
  await expect(add).toHaveCount(0,{timeout:20000});
  await expect(page.locator('[data-mcp-id="opencode:opencode_fixture"]')).toBeVisible({timeout:20000});
  assert.deepEqual(errors,[]);
}

if(process.argv.includes('--run')&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let browser;
 try{
  const base=await mkdtemp(path.join(os.tmpdir(),'mik-tools-concept-')),repo=path.join(base,'Hub'),home=path.join(base,'home');
  for(const directory of ['workspace','context','inbox','knowledge','processes'])await mkdir(path.join(repo,directory),{recursive:true});
  await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
  const service=await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home,env:{},probe:async()=>({status:'available',toolCount:7})}});
  const fixture=await seedWorkspaceFiles(service,repo,base);
  fixture.request=async(route,data)=>{const response=await fetch(service.origin+'/api'+route,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();assert.ok(response.ok,value.error);return value};
  await seedTools(fixture);
  browser=await chromium.launch({channel:'msedge',headless:true,env:testBrowserEnvironment()});
  const page=await browser.newPage({viewport:{width:1100,height:850}});await page.goto(service.urls.workspace);
  await exerciseTools(page,fixture);
  assert.match(await readFile(path.join(fixture.linked.repositoryPath,'.mcp.json'),'utf8'),/synthetic-private-fixture/);
  console.log('PASS Tools concept UI: compact controls, isolated scopes, owned-only edits, hidden preferences, nested browser menus, diagnostics and 320–1100px geometry.');
 }finally{await browser?.close();await cleanupFixtures()}
}
