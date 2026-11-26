// Shared Codex/Claude chrome in the production UI; synthetic runtimes only.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cp, mkdir, writeFile } from 'node:fs/promises';
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
let service, browser;
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
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  for(const [index,item] of chats.entries()) {const session=service.sessions.get(item.id);session.projectId=project.id;session.repositoryId='primary';session.name=index?'Components and layout':'Navigation concept';session.completionVersion=index?0:1;service.sessions.changed(session);}
  const current=service.sessions.get(chats[0].id),runtime=current.graphical;
  runtime.items=new Map([['visual-user',{id:'visual-user',turnId:'visual-turn',type:'userMessage',text:'Make it easier to switch projects and follow active chats.',status:'completed',details:''}],['visual-answer',{id:'visual-answer',turnId:'visual-turn',type:'agentMessage',text:'I have reorganized the controls and navigation. Conversation operations remain available in their respective menus.',status:'completed',details:''}]]);
  current.hasConversation=true;
  runtime.turns=new Map([['visual-turn',{id:'visual-turn',status:'completed',startedAt:null,completedAt:null,durationMs:18000,timingSource:'native'}]]);runtime.changed();
  await focus(current.id);await page.setViewportSize({width:1018,height:780});await page.goto(service.urls.chats);
  const drawer=page.getByRole('complementary',{name:'Conversations by project'});await expect(drawer).toBeVisible();
  const screenshot=async name=>{await page.screenshot({path:path.join(root,`.cache/concept-alignment-${name}.png`),animations:'disabled'});};
  await screenshot('main');
  const geometry=await page.evaluate(()=>Object.fromEntries(['.chats-header','.project-chat-rail','.project-chat-drawer','.chat-tabs-row','.graphical-composer','.graphical-controls','.graphical-primary-action'].map(selector=>{const b=document.querySelector(selector).getBoundingClientRect();return [selector,{x:b.x,y:b.y,width:b.width,height:b.height}]})));
  await writeFile(path.join(root,'.cache/concept-alignment-metrics.json'),JSON.stringify(geometry,null,2));
  assert.equal(geometry['.chats-header'].height,53);assert.equal(geometry['.project-chat-rail'].width,55);assert.equal(geometry['.project-chat-drawer'].width,270);assert.equal(geometry['.chat-tabs-row'].height,71);
  const send=geometry['.graphical-primary-action'],controls=geometry['.graphical-controls'];assert.ok(Math.abs(send.y-controls.y)<=4,'Send belongs in the lower controls row');assert.equal(send.width,30);
  assert.ok(Math.abs(geometry['.graphical-composer'].height-148.5)<=4,'Composer height follows approved reference');
  const modelTrigger=page.getByRole('combobox',{name:'Model and reasoning',exact:true});await modelTrigger.click();await screenshot('model');
  const triggerBox=await modelTrigger.boundingBox(),modelBox=await page.getByRole('dialog',{name:'Model and reasoning',exact:true}).boundingBox();assert.ok(Math.abs(triggerBox.x-modelBox.x)<2,'Model menu aligns to its trigger');
  await page.getByRole('combobox',{name:'Model',exact:true}).click();const modelOptions=page.getByRole('listbox',{name:'Model',exact:true});await expect(modelOptions).toBeVisible();await modelOptions.getByRole('option').first().press('Escape');await expect(modelOptions).toHaveCount(0);await expect(page.getByRole('dialog',{name:'Model and reasoning',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await page.getByLabel('Chat details',{exact:true}).click();await screenshot('details');await page.keyboard.press('Escape');await expect(drawer).toBeVisible();
  const rowTrigger=drawer.getByRole('button',{name:'Actions for Navigation concept',exact:true});await rowTrigger.click();await screenshot('row-menu');
  const rowMenuBox=await page.getByRole('dialog',{name:'Actions for Navigation concept',exact:true}).boundingBox(),rowTriggerBox=await rowTrigger.boundingBox();assert.ok(Math.abs(rowMenuBox.y-rowTriggerBox.y)<2,'Row menu starts beside its own trigger when there is room');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'New chat',exact:true}).first().click();await screenshot('create');await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.keyboard.press('Control+Shift+h');await screenshot('history');await page.keyboard.press('Escape');
  await drawer.getByRole('button',{name:'Find a chat',exact:true}).click();await screenshot('search');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();await screenshot('preferences');
  const preferences=page.getByRole('dialog',{name:'Navigation preferences',exact:true}),anchor=await page.getByRole('button',{name:'Navigation preferences',exact:true}).boundingBox();const preferencesBox=await preferences.boundingBox();assert.ok(Math.abs(preferencesBox.x-anchor.x-anchor.width-5)<2,'Preferences open next to the rail button');
  await preferences.getByRole('button',{name:'Shortcuts',exact:true}).click();await screenshot('shortcuts');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();await page.keyboard.press('Control+Shift+t');await expect(page.locator('form.chat-create-dialog')).toBeVisible();await page.keyboard.press('Tab');assert.ok(await page.locator('form.chat-create-dialog').evaluate(form=>form.contains(document.activeElement)),'A new modal owns keyboard focus instead of the previous popover');await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await screenshot('narrow');
  await page.getByRole('button',{name:'Collapse projects',exact:true}).click();await modelTrigger.click();const narrowMenu=await page.getByRole('dialog',{name:'Model and reasoning',exact:true}).boundingBox();assert.ok(narrowMenu.x>=0&&narrowMenu.x+narrowMenu.width<=391);await screenshot('narrow-model');await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);console.log('PASS visual capture: main/model/details/row/create/history/search/narrow; synthetic runtime only.');
} finally {await browser?.close();await service?.close();for(const wire of claudeWires)wire.close();await cleanupFixtures();}
