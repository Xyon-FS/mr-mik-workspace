import { selectControl } from './select-control.mjs';
// Shared Codex/Claude chrome in the production UI; synthetic runtimes only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';

const root = path.resolve('.'), portableIndex = process.argv.indexOf('--portable');
const runtimeRoot = portableIndex < 0 ? path.join(root, 'desktop/service') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/service');
const uiDir = portableIndex < 0 ? path.join(root, 'dist') : path.resolve(process.argv[portableIndex + 1], 'App/runtime/ui');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-provider-layout-')), nativeEvents = [], claudeWires = [];
let service, browser, page;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home);
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await cp(uiDir, path.join(base, 'ui'), {recursive:true}); await cp(path.join(root,'public/assets'),path.join(base,'ui/assets'),{recursive:true});
  service = await createService({ repo, uiDir:path.join(base,'ui'), native: event => nativeEvents.push(event), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
  const profile = await service.profiles.create('Layout fixture');
  service.accountLimitReader.context = async (_agent, profileId) => ({ directory: profileId });
  service.accountLimitReader.codex = async () => ({ windows: [{ label: '5h', percent: 25, resetsAt: null }] });
  service.accountLimitReader.claude = async () => ({ windows: [{ label: '5h', percent: 0, resetsAt: null }] });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const codex = graphicalFixture({ modelCatalogue: [{ model: 'fixture-model', displayName: 'Fixture model', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] });
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const fixture = claudeFixture(options.session.nativeId, { commands: [{ name: 'fixture-context', description: 'Fixture selectable native skill' }, { name: 'compact', builtin: true }], contextUsage: { totalTokens: 12000, maxTokens: 200000 }, usage: { session: { model_usage: { fixture: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }, rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: null, resets_at: null } } } }); claudeWires.push(fixture);
    return new ClaudeChat({ ...options, transportFactory: fixture.factory });
  };
  const projectDir=path.join(base,'project');await mkdir(projectDir);
  const project=await service.projects.save({name:'Mr. Mik',repositoryPath:projectDir});
  const chats = [];
  for (const agent of ['codex', 'claude']) chats.push(await service.sessions.create({ agent, chatInterface: 'chat', cwd: projectDir, projectId: project.id, repositoryId: 'primary', name: `${agent} shared layout`, accountProfileId: agent === 'codex' ? profile.id : undefined }));
  const focus = async id => {
    const response = await fetch(`${service.origin}/api/sessions/${id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.ok(response.ok);
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const browserContext=await browser.newContext(); page = await browserContext.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  for(const [index,item] of chats.entries()) {const session=service.sessions.get(item.id);session.projectId=project.id;session.repositoryId='primary';session.name=index?'Components and layout':'Navigation concept';session.completionVersion=index?0:1;service.sessions.changed(session);}
  const linkedDir=path.join(base,'linked');await mkdir(linkedDir);
  const linked=await service.projects.saveRepository({projectId:project.id,name:'Linked source',repositoryPath:linkedDir});
  const globalCard=await service.projects.createCard({projectId:null,title:'Global output card'}),projectCard=await service.projects.createCard({projectId:project.id,repositoryId:linked.id,title:'Linked output card'});
  const workspace=await page.context().newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);await workspace.goto(service.urls.workspace);
  const html='<!doctype html><html><body><button onclick="this.textContent=\'Clicked\'">Try concept</button></body></html>';
  for(const seed of chats){
    const current=service.sessions.get(seed.id),runtime=current.graphical,turn='polish-turn',answer=`${seed.agent}-answer`,user=`${seed.agent}-user`;
    const items=[{id:user,turnId:turn,type:'userMessage',text:'ok',status:'completed',details:''},{id:answer,turnId:turn,type:'agentMessage',text:'Two outputs\n```html\n'+html+'\n```\n```javascript\nconst selectedValue = 7;\n```',status:'completed',details:''}],turns=[{id:turn,status:'completed',startedAt:null,completedAt:null,durationMs:1000}];
    if(seed.agent==='codex'){runtime.items=new Map(items.map(item=>[item.id,item]));runtime.turns=new Map(turns.map(turn=>[turn.id,turn]));}else Object.assign(runtime.protocol.state,{items,turns,status:'ready'});
    current.hasConversation=true;runtime.changed();
    await focus(seed.id);await page.bringToFront();await page.goto(service.urls.chats);
    const chat=page.getByRole('region',{name:`${seed.agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true});await expect(chat).toBeVisible();
    const drawer=page.getByRole('complementary',{name:'Conversations by project'});if(await drawer.isVisible())await page.getByRole('button',{name:'Collapse project panel',exact:true}).click();
    for(const width of (process.env.MRMAK_POLISH_QUICK ? [1100] : [1100,390,320])){
      await page.setViewportSize({width,height:900});
      for(const article of [chat.locator(`[data-chat-item="${user}"]`),chat.locator(`[data-chat-item="${answer}"]`)]){
        const toolbar=article.getByRole('toolbar',{name:'Message actions'});await toolbar.scrollIntoViewIfNeeded();
        const buttons=await toolbar.getByRole('button').all(),boxes=await Promise.all(buttons.map(button=>button.boundingBox()));
        assert.ok(boxes.length>=2);assert.ok(boxes.every(box=>box.height===26),'Action heights agree');assert.ok(Math.max(...boxes.map(box=>box.y))-Math.min(...boxes.map(box=>box.y))<=1,'Actions share one baseline');
        for(const box of boxes)assert.ok(box.x>=0&&box.x+box.width<=width+1,'No vertically broken/offscreen message buttons');
        const sibling=buttons[1];await page.mouse.move(0,0);const before=await sibling.evaluate(element=>({color:getComputedStyle(element).color,opacity:getComputedStyle(element).opacity}));await article.hover();await buttons[0].hover();await page.waitForTimeout(160);assert.deepEqual(await sibling.evaluate(element=>({color:getComputedStyle(element).color,opacity:getComputedStyle(element).opacity})),before,'Hover only highlights the target action');
      }
      await chat.getByRole('combobox',{name:'Model and reasoning',exact:true}).click();const picker=page.getByRole('dialog',{name:'Model and reasoning',exact:true});const bounds=await picker.boundingBox();assert.ok(bounds.width<=321&&bounds.height<350,'Compact picker avoids redundant platform/account rows');await page.screenshot({path:path.join(root,`.cache/chat-polish-${seed.agent}-model-${width}.png`)});await page.keyboard.press('Escape');
      const permissions=chat.getByRole('combobox',{name:seed.agent==='codex'?'Codex permissions':'Claude permissions',exact:true});await permissions.click();await expect(page.locator('.permission-options')).toBeVisible();await expect(page.getByRole('option',{name:'Use Codex settings',exact:true})).toHaveCount(0);const menu=await page.locator('.permission-options').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width+1);await page.screenshot({path:path.join(root,`.cache/chat-polish-${seed.agent}-permissions-${width}.png`)});await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:1100,height:900});
    await page.bringToFront();console.log(`Quote navigation ${seed.agent}: ${await page.evaluate(()=>document.visibilityState)}`);await chat.locator(`[data-chat-item="${user}"]`).hover();await chat.locator(`[data-chat-item="${user}"]`).getByRole('button',{name:'Quote message',exact:true}).click();await expect(chat.getByRole('button',{name:'Remove quote',exact:true})).toBeVisible();await page.bringToFront();await page.screenshot({path:path.join(root,`.cache/chat-content-ux-integration/${seed.agent}-quote-navigation.png`)});console.log(JSON.stringify({agent:seed.agent,quoteBox:await chat.getByRole('button',{name:'Remove quote',exact:true}).boundingBox()}));await chat.getByRole('button',{name:'Remove quote',exact:true}).click();
    await chat.getByLabel('Chat details',{exact:true}).click();await chat.getByRole('tab',{name:'Actions',exact:true}).click();const geometry=await chat.locator('.conversation-actions').evaluate(el=>({action:el.querySelector(':scope > button svg').getBoundingClientRect().x,color:el.querySelector('.conversation-setting-title svg').getBoundingClientRect().x}));assert.ok(Math.abs(geometry.action-geometry.color)<=1,'Graphical Tab color aligns with action icons');await page.screenshot({path:path.join(root,`.cache/chat-row-${seed.agent}-actions.png`)});await chat.getByRole('tab',{name:'Context',exact:true}).click();await expect(chat.getByRole('button',{name:'Conversation outputs',exact:true})).toHaveCount(0);await chat.getByRole('tab',{name:'Session',exact:true}).click();await chat.getByRole('button',{name:'Conversation outputs',exact:true}).click();
    const outputs=page.getByRole('dialog',{name:'Conversation outputs',exact:true});await expect(outputs.getByRole('textbox',{name:'Filter conversation outputs'})).toBeFocused();await expect(outputs.locator('article')).toHaveCount(2);
    await outputs.getByRole('button',{name:'Code',exact:true}).click();await outputs.getByRole('textbox',{name:'Filter conversation outputs'}).fill('javascript');await expect(outputs.locator('article')).toHaveCount(1);const describe=page.waitForResponse(response=>response.url().endsWith('/output')&&response.request().postDataJSON()?.action==='describe');await outputs.getByRole('button',{name:'Artifact actions',exact:true}).click();await outputs.getByRole('dialog',{name:'Artifact actions',exact:true}).getByRole('button',{name:'Add output to card',exact:true}).click();const description=await describe;assert.ok(description.ok(),await description.text());
    const save=page.getByRole('dialog',{name:'Add to card',exact:true});await selectControl(page, 'Destination', '');await save.getByLabel('New card title',{exact:true}).fill(`${seed.agent} selected block`);await save.getByRole('button',{name:'Save note',exact:true}).click();await expect(save.getByRole('status')).toContainText('Saved in');await save.getByRole('button',{name:'Close card dialog'}).click();
    const registry=JSON.parse(await readFile(service.projects.workspacePath,'utf8')),saved=registry.entities.find(card=>card.title===`${seed.agent} selected block`),text=await readFile(path.join(repo,'workspace',saved.folder,saved.steps[0].path),'utf8');assert.match(text,/const selectedValue = 7/);assert.doesNotMatch(text,/Try concept/);
    await outputs.getByRole('textbox',{name:'Filter conversation outputs'}).fill('html');await outputs.getByRole('button',{name:'Open html snippet',exact:true}).click();await expect(workspace.locator('.workspace-preview-slot:not([hidden])').frameLocator('iframe[title="Interactive HTML preview"]').getByRole('button',{name:'Try concept'})).toBeVisible();
    await page.setViewportSize({width:390,height:900});await page.screenshot({path:path.join(root,`.cache/chat-polish-${seed.agent}-outputs.png`)});const box=await outputs.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391);await outputs.getByRole('button',{name:'Close conversation outputs'}).click();await expect(chat.getByRole('button',{name:'Conversation outputs',exact:true})).toBeFocused();await page.keyboard.press('Escape');
    if(seed.agent==='codex'){
      codex.children[0].request(900,'item/commandExecution/requestApproval',{threadId:current.nativeId,turnId:turn,command:'echo fixture',reason:'Approval layout',availableDecisions:['accept','decline']});
      const approval=chat.getByRole('region',{name:'Agent request',exact:true});await expect(approval).toBeVisible();for(const button of await approval.getByRole('button').all())assert.ok((await button.boundingBox()).height<=30);await page.screenshot({path:path.join(root,'.cache/chat-polish-approval.png')});await approval.getByRole('button',{name:'Allow once',exact:true}).click();await expect.poll(()=>codex.calls.find(call=>call.id===900&&call.result)?.result?.decision).toBe('accept');
    }
  }
  await page.setViewportSize({width:1100,height:900});await page.getByRole('button',{name:'New chat',exact:true}).first().click();const creation=page.locator('form.chat-create-dialog');for(const provider of [{name:'Codex',color:'rgb(136, 216, 191)'},{name:'Claude Code',color:'rgb(219, 166, 140)'}])assert.equal(await creation.getByRole('button',{name:provider.name,exact:true}).locator('.creation-provider-icon').evaluate(el=>getComputedStyle(el).color),provider.color);await expect(creation.getByRole('group',{name:'Platform',exact:true})).toBeVisible();await expect(creation.getByText('Your subscription',{exact:true}).first()).toBeVisible();
  await creation.getByRole('combobox',{name:'Workspace',exact:true}).click();await page.getByRole('option',{name:'Global Hub',exact:true}).click();await expect(creation.getByRole('combobox',{name:'Card',exact:true})).toBeVisible();await creation.getByRole('combobox',{name:'Card',exact:true}).click();await page.getByRole('option',{name:globalCard.title,exact:true}).click();await expect(creation.getByRole('combobox',{name:'Working project',exact:true})).toBeDisabled();await expect(creation.getByRole('textbox',{name:'Working folder'})).toHaveCount(0);
  await creation.getByRole('combobox',{name:'Workspace',exact:true}).click();await page.getByRole('option',{name:'Mr. Mik',exact:true}).click();await creation.getByRole('combobox',{name:'Card',exact:true}).click();await page.getByRole('option',{name:projectCard.title,exact:true}).click();await creation.getByRole('combobox',{name:'Working project',exact:true}).click();await page.getByRole('option',{name:'Linked source',exact:true}).click();await creation.getByRole('group',{name:'Platform',exact:true}).getByRole('button',{name:'Claude Code',exact:true}).click();await creation.getByRole('combobox',{name:'Chat interface'}).click();await page.getByRole('option',{name:'Chat',exact:true}).click();await creation.getByPlaceholder('e.g. Dream Game · animations').fill('Associated chat');await page.screenshot({path:path.join(root,'.cache/chat-polish-creation.png')});
  const created=page.waitForResponse(response=>response.url().endsWith('/api/sessions')&&response.request().method()==='POST');await creation.getByRole('button',{name:'Open chat',exact:true}).click();const response=await created;assert.ok(response.ok(),await response.text());const payload=response.request().postDataJSON();assert.equal(payload.cardId,projectCard.id);assert.equal(payload.repositoryId,linked.id);assert.equal(payload.projectId,project.id);
  assert.deepEqual(errors,[]);assert.equal(codex.calls.some(call=>call.method==='turn/start'),false);assert.equal(claudeWires.flatMap(w=>w.calls).some(call=>call.type==='user'),false);
  console.log('PASS chat polish: compact model/permission menus, aligned short-message actions, quote, Session output browser, filters, selected-block card save, real Workspace preview, provider cards, Hub/project card and linked-project creation. 320–1100px; zero inference.');
}catch(error){console.log(error);if(page){await page.screenshot({path:path.join(root,'.cache/chat-polish-failure.png'),timeout:5000}).catch(()=>{});console.log(await page.locator('dialog').allTextContents().catch(()=>[]))}throw error}finally{await browser?.close();await service?.close();for(const wire of claudeWires)wire.close();await cleanupFixtures();}
