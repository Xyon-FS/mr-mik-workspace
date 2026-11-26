// Real UI/service, isolated transcripts and fake PTYs: no model or user session.
import { selectChatInNavigation } from './chat-navigation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { claudeTranscript } from '../native-events.mjs';
import { claudeModelScreen, claudeEffortScreen } from './claude-picker-layouts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const portableIndex = process.argv.indexOf('--portable'), portable = portableIndex < 0 ? null : path.resolve(process.argv[portableIndex + 1]);
const factory = portable ? (await import(pathToFileURL(path.join(portable, 'App/runtime/service/server.mjs')))).createService : undefined;
const base = await mkdtemp(path.join(os.tmpdir(), 'mrmak-controls-ui-'));
const repo = path.join(base, 'hub'), linked = path.join(base, 'project'), uiDir = path.join(base, 'ui');
await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(linked);
await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
await cp(portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), uiDir, { recursive: true }); await cp(path.join(root, 'public/assets'), path.join(uiDir, 'assets'), { recursive: true });
const previousCodex = process.env.CODEX_HOME, previousClaude = process.env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = path.join(base, 'codex'); process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
const service = await createService({ repo, uiDir, mcpOptions: { home: path.join(base, 'home'), env: {} } }, factory);
let browser;
try {
  const project = await service.projects.save({ name: 'Game', repositoryPath: linked });
  const card = await service.projects.createCard({ projectId: project.id, title: 'Development', repositoryId: 'primary' });
  service.sessions.verifyIdentity = async () => {};
  const profile = await service.profiles.create('Synthetic CLI controls');
  const keys = new Map();
  service.sessions.launch = async (session, resumeId, boundary) => {
    assert.ok(resumeId && boundary.fork);
    if (session.agent === 'codex') session.nativeId = randomUUID();
    session.process = { write: key => keys.get(session.id).push(key), resize() {}, kill() {} };
    keys.set(session.id, []); session.status = 'running'; service.sessions.changed(session);
  };
  const sources = [];
  const nativeScreens = new Map();
  const read = service.sessions.read.bind(service.sessions);
  service.sessions.read = async (id, lines) => ({ ...await read(id, lines), ...(nativeScreens.has(id) ? { screen: nativeScreens.get(id) } : {}) });
  for (const agent of ['codex', 'claude']) {
    const nativeId = randomUUID();
    const transcript = agent === 'codex' ? path.join(process.env.CODEX_HOME, 'sessions/2026/09/30', `rollout-fixture-${nativeId}.jsonl`) : await claudeTranscript(linked, nativeId);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify(agent === 'codex' ? { type: 'session_meta', payload: { id: nativeId, cwd: linked } } : { type: 'user', sessionId: nativeId, message: { content: 'Fixture' } }) + '\n');
    const session = service.sessions.make({ id: randomUUID(), agent, ...(agent === 'codex' ? { accountProfileId: profile.id } : {}), cliModelLabel: agent === 'codex' ? 'GPT-6.1-Sol' : 'Haiku', name: `${agent} source`, cwd: linked, projectId: project.id, repositoryId: 'primary', cardId: card.id, nativeId, status: 'running', activity: 'idle', open: true, cols: 90, rows: 32, createdAt: new Date().toISOString() });
    let permissionIndex = 0, level = 2, stage = 'idle', modelIndex = 4, codexModel = 'GPT-6.1-Sol';
    const localRecords = (command, output) => { if (agent === 'claude') void appendFile(transcript, [{ type: 'user', message: { content: `<command-name>/${command}</command-name>\n<command-message>${command}</command-message>\n<command-args></command-args>` } }, { type: 'user', message: { content: `<local-command-stdout>${output}</local-command-stdout>` } }].map(row => JSON.stringify(row) + '\n').join('')); };
    const claudeModels = () => claudeModelScreen(modelIndex);
    const effortScreen = () => agent === 'codex' ? `Select Reasoning Level for ${codexModel}\n${['Low', 'Medium', 'High'].map((label, i) => `${i === level ? '›' : ' '} ${i + 1}. ${label}${i === 1 ? ' (default)' : ''}`).join('\n')}\nenter default · s session · esc back` : claudeEffortScreen(level);
    nativeScreens.set(session.id, agent === 'codex' ? '› Ask Codex to do anything' : '❯');
    keys.set(session.id, []); session.process = { write: key => {
      keys.get(session.id).push(key);
      if (key === '\x1b[Z' && agent === 'claude') { permissionIndex=(permissionIndex+1)%4;nativeScreens.set(session.id,'❯\n ⏵⏵ '+['auto mode','manual mode','accept edits','plan mode'][permissionIndex]+' on (shift+tab to cycle)'); }
      else if (key === '/model' || key === '/effort') { stage = key; nativeScreens.set(session.id, `${agent === 'codex' ? '›' : '❯'} ${key}`); }
      else if (key === '\r' && stage === '/model' && agent === 'claude') { stage = 'claude-model'; nativeScreens.set(session.id, claudeModels()); }
      else if (stage === 'claude-model' && ['\x1b[B', '\x1b[A'].includes(key)) { modelIndex += key === '\x1b[B' ? 1 : -1; nativeScreens.set(session.id, claudeModels()); }
      else if (stage === 'claude-model' && key === 's') { stage = 'idle'; const notice = 'Set model to ' + ['Default', 'Opus', 'Fable', 'Sonnet', 'Haiku'][modelIndex]; nativeScreens.set(session.id, notice + '\n❯'); localRecords('model', notice); }
      else if (key === '\r' && stage === '/model') { stage = 'model'; nativeScreens.set(session.id, 'Select Model and Effort\n› 1. GPT-6.1-Sol (current)\n  2. GPT-6-Luna\n  3. GPT-6.1 Terra  Synthetic Terra description\nenter select · esc back'); }
      else if (stage === 'model' && key === '3') { codexModel = 'GPT-6.1 Terra'; level = 1; stage = 'effort'; nativeScreens.set(session.id, effortScreen()); }
      else if (stage === 'effort' && key === '2' && agent === 'codex') { level = 1; stage = 'idle'; nativeScreens.set(session.id, 'Model changed to gpt-6.1-terra medium\n› Ask Codex to do anything'); }
      else if (key === '\r' && stage === '/effort' || key === '1' && stage === 'model') { stage = 'effort'; nativeScreens.set(session.id, effortScreen()); }
      else if (stage === 'effort' && ['\x1b[A', '\x1b[D', '\x1b[B', '\x1b[C'].includes(key)) { level += ['\x1b[A', '\x1b[D'].includes(key) ? -1 : 1; nativeScreens.set(session.id, effortScreen()); }
      else if (stage === 'effort' && key === 's') { stage = 'idle'; const notice = 'Effort set to ' + ['low', 'medium', 'high', 'xhigh', 'max'][level] + ' for this session'; nativeScreens.set(session.id, agent === 'codex' ? 'Model changed to gpt-6.1-sol low\n› Ask Codex to do anything' : notice + '\n❯'); localRecords('effort', notice); }
    }, resize() {}, kill() {} };
    service.sessions.items.set(session.id, session); await service.sessions.hydrate(session);
    if (agent === 'claude') service.sessions.watchNative(session, transcript, (await stat(transcript)).size);
    await new Promise(resolve => session.terminal.write('Fixture prompt\r\n> ', resolve)); sources.push(session);
  }
  service.sessions.changed(sources[0]);
  browser = await chromium.launch({ env: testBrowserEnvironment(), headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 650, height: 750 } }); const errors = []; page.on('pageerror', error => errors.push(error.stack || error.message));
  let holdSettings=false;const heldSettings=[];
  await page.routeWebSocket('**/events',socket=>{const upstream=socket.connectToServer();upstream.onMessage(message=>{let event;try{event=JSON.parse(String(message))}catch{}if(holdSettings&&event?.type==='settings')heldSettings.push(()=>socket.send(message));else socket.send(message)})});
  await page.goto(service.urls.chats);
  for (const source of sources) {
    await selectChatInNavigation(page, source.id);
    await expect(page.locator(`[data-chat-tab="${source.id}"] [role=tab]`)).toHaveAttribute('aria-selected', 'true');
    const send = page.getByRole('button', { name: 'Send typed CLI prompt', exact: true }); await send.waitFor();
    assert.equal(await page.locator('.cli-session-toolbar').getByRole('button', { name: 'Send typed CLI prompt' }).count(), 1);
    assert.equal(await page.locator('.terminal-area .terminal-turn-control').count(), 0);
    await page.locator('.xterm-helper-textarea').pressSequentially('hello');
    const responsePromise = page.waitForResponse(response => response.url().endsWith(`/sessions/${source.id}/control`));
    await send.click(); const response = await responsePromise; assert.equal(response.ok(), true, await response.text());
    await expect.poll(() => keys.get(source.id).includes('\r')).toBe(true);
    source.activity = 'working'; service.sessions.changed(source);
    await page.getByRole('button', { name: 'Interrupt response', exact: true }).click();
    await page.waitForTimeout(100); assert.equal(keys.get(source.id).at(-1), '\x1b'); assert.ok(source.process);
    source.activity = 'idle'; source.attention = false; service.sessions.changed(source);
    await page.getByLabel('Chat details', {exact:true}).click();
    await page.getByRole('tab',{name:'Actions',exact:true}).click();
    await page.getByRole('button', { name: 'Fork selected conversation', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.chat-tab').length >= count, 3 + sources.indexOf(source));
    const fork = service.sessions.list().find(item => item.name === `Fork · ${source.name}`);
    await expect(page.locator(`[data-chat-tab="${fork.id}"] [role=tab]`)).toHaveAttribute('aria-selected', 'true');
    assert.equal(fork.cliModelLabel,source.cliModelLabel,'CLI fork retains the source confirmed model');
    await expect(page.locator('.cli-session-settings > summary')).toContainText(source.cliModelLabel);
    assert.ok(fork && fork.nativeId !== source.nativeId); assert.equal(fork.cardId, source.cardId); assert.equal(fork.projectId, source.projectId); assert.equal(fork.repositoryId, source.repositoryId);
  }
  for (const source of sources) {
    source.activity = 'idle'; service.sessions.changed(source);
    await selectChatInNavigation(page, source.id);
    await expect(page.locator(`[data-chat-tab="${source.id}"] [role=tab]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.cli-session-settings')).toHaveCount(1);
    await expect(page.locator('.cli-session-settings > summary')).toContainText(source.cliModelLabel);
    await page.locator('.cli-session-settings > summary').click();
    await expect(page.getByRole('button', { name: 'Chat reasoning', exact: true })).toHaveAttribute('title', `Choose ${source.agent === 'claude' ? 'Claude' : 'Codex'} reasoning in this chat`);
    const pickerResponse = page.waitForResponse(response => response.url().endsWith(`/sessions/${source.id}/reasoning-picker`));
    await page.getByRole('button', { name: 'Chat reasoning', exact: true }).click();
    const picker = await pickerResponse; assert.equal(picker.ok(), true, source.agent + ': ' + await picker.text());
    await page.locator('.chat-model-menu').getByRole('button', { name: /^low$/i }).click();
    await page.waitForTimeout(150);
    assert.equal(source.effort, 'low'); assert.equal(keys.get(source.id).at(-1), 's');
  }
  const codex = sources.find(source => source.agent === 'codex'), codexProcess = codex.process;
  await selectChatInNavigation(page, codex.id);
  await page.locator('.cli-session-settings > summary').click();
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Codex models', exact: true }).getByRole('button', { name: 'GPT-6.1 Terra', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Codex models', exact: true }).getByRole('button', { name: 'GPT-6.1 Terra', exact: true }).click();
  await expect(page.locator('.chat-model-menu')).toHaveCount(0);
  assert.equal(codex.process, codexProcess); assert.equal(codex.effort, 'medium');
  await expect(page.locator('.cli-session-settings > summary')).toContainText('GPT-6.1 Terra');
  assert.equal(service.sessions.list().find(s=>s.id===codex.id).cliModelLabel,'GPT-6.1 Terra');
  assert.deepEqual(keys.get(codex.id).slice(-4), ['/model', '\r', '3', '2']);
  const claude = sources.find(source => source.agent === 'claude'), processBefore = claude.process;
  await selectChatInNavigation(page, claude.id);
  await expect(page.locator(`[data-chat-tab="${claude.id}"] [role=tab]`)).toHaveAttribute('aria-selected', 'true');
  await page.locator('.cli-session-settings > summary').click();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toHaveAttribute('title', 'Choose a Claude model in this chat');
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Claude models', exact: true })).toBeVisible();
  await expect(page.locator('.chat-model-menu')).not.toContainText('Synthetic native description');
  await expect(page.locator('.chat-model-menu').getByRole('button', { name: /^Fable/ })).toBeVisible();
  const fableChoice=page.locator('.chat-model-menu').getByRole('button',{name:/^Fable/});await fableChoice.focus();await fableChoice.press('ArrowDown');await expect(page.locator('.chat-model-menu').getByRole('button',{name:/^Sonnet/})).toBeFocused();
  await page.locator('.chat-model-menu').getByRole('button', { name: /^Sonnet/ }).click();
  await expect(page.locator('.chat-model-menu')).toHaveCount(0);
  assert.equal(claude.process, processBefore); assert.equal(keys.get(claude.id).at(-1), 's');
  for (const [model, effort] of [['Opus', 'medium'], ['Haiku', 'low']]) {
    // Give the native transcript watcher time to consume both local records.
    await page.waitForTimeout(650); assert.equal(claude.activity, 'idle');
    await page.getByRole('button', { name: 'Choose model', exact: true }).click();
    await page.getByRole('group', { name: 'Claude models', exact: true }).getByRole('button', { name: new RegExp('^' + model) }).click();
    await expect(page.locator('.chat-model-menu')).toHaveCount(0);
    await page.waitForTimeout(650); assert.equal(claude.activity, 'idle');
    await page.getByRole('button', { name: 'Chat reasoning', exact: true }).click();
    await page.locator('.chat-model-menu').getByRole('button', { name: new RegExp('^' + effort + '$', 'i') }).click();
    await expect(page.locator('.chat-model-menu')).toHaveCount(0);
  }
  // Collapsing the wrapper must cancel the native picker, not leave the PTY in a menu.
  await page.getByRole('button', { name: 'Choose model', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Claude models', exact: true })).toBeVisible();
  await page.locator('.cli-session-settings > summary').click();
  await expect.poll(() => keys.get(claude.id).at(-1)).toBe('\x1b');
  await expect(page.locator('.chat-model-menu')).toHaveCount(0);
  await page.waitForTimeout(650); assert.equal(claude.activity, 'idle'); assert.equal(claude.completionVersion, 0); assert.equal(claude.process, processBefore);
  nativeScreens.set(claude.id,'❯\n ⏵⏵ auto mode on (shift+tab to cycle)');claude.claudePermissionMode='auto';service.sessions.changed(claude);
  const permissions=page.getByRole('combobox',{name:'Claude permissions',exact:true});await expect(permissions).toContainText('Auto');await permissions.click();await page.getByRole('option',{name:'Accept edits',exact:true}).click();
  await expect(permissions).toContainText('Accept edits');assert.equal(claude.claudePermissionMode,'acceptEdits');assert.equal(claude.process,processBefore);assert.deepEqual(keys.get(claude.id).slice(-2),['\x1b[Z','\x1b[Z']);
  await page.screenshot({path:path.join(root,'.cache/claude-cli-final-permissions.png')});
  await selectChatInNavigation(page, sources[0].id);
  await page.locator('.cli-session-settings > summary').click();
  await page.getByRole('button',{name:'Choose model',exact:true}).click();
  await expect(page.getByRole('group',{name:'Codex models',exact:true})).toBeVisible();
  const escapesBeforeSwitch=keys.get(codex.id).filter(key=>key==='\x1b').length;
  await page.keyboard.press('Control+Tab');
  await expect.poll(()=>keys.get(codex.id).filter(key=>key==='\x1b').length).toBe(escapesBeforeSwitch+1);
  await selectChatInNavigation(page,codex.id);
  // Delayed HTTP response: a keyboard switch must cancel the old PTY after open settles.
  let releasePicker, reachedPicker;
  const releaseGate=new Promise(resolve=>{releasePicker=resolve}), reachedGate=new Promise(resolve=>{reachedPicker=resolve});
  const pickerPattern=new RegExp(`/api/sessions/${codex.id}/model-picker$`);
  await page.route(pickerPattern,async route=>{
    if(route.request().postDataJSON()?.action!=='open')return route.continue();
    const response=await route.fetch();reachedPicker();await releaseGate;await route.fulfill({response});
  });
  try {
    await page.locator('.cli-session-settings > summary').click();await page.getByRole('button',{name:'Choose model',exact:true}).click();
    await reachedGate;const before=keys.get(codex.id).filter(key=>key==='\x1b').length;
    await page.keyboard.press('Control+Tab');releasePicker();
    await expect.poll(()=>keys.get(codex.id).filter(key=>key==='\x1b').length).toBe(before+1);
    await selectChatInNavigation(page,codex.id);await expect(page.locator('.cli-session-settings')).not.toHaveAttribute('open','');
  } finally {releasePicker();await page.unroute(pickerPattern);}
  // Approved CLI chrome must preserve the existing terminal and native state.
  await selectChatInNavigation(page, codex.id);
  const header=page.locator('.chat-tab-actions');
  await expect(header.getByRole('button',{name:'Attach files',exact:true})).toBeVisible();
  for(const name of ['Find a chat','History','New chat']) await expect(header.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(page.locator('.cli-session-toolbar').getByRole('button',{name:'Attach files',exact:true})).toHaveCount(0);
  const details=page.locator('details.graphical-details');await details.locator('summary').click();
  for(const name of ['Session','Context']){await details.getByRole('tab',{name,exact:true}).click();await expect(details.getByRole('group',{name:'Terminal appearance',exact:true})).not.toBeVisible();await expect(details.getByRole('spinbutton',{name:'Terminal text size',exact:true})).not.toBeVisible();}
  await details.getByRole('tab',{name:'Actions',exact:true}).click();
  const columns=await details.locator('.conversation-actions').evaluate(section=>{const x=section.querySelector(':scope > button > svg').getBoundingClientRect().x;return [...section.querySelectorAll('.conversation-setting-title svg')].map(icon=>Math.abs(icon.getBoundingClientRect().x-x))});
  assert.equal(columns.length,3);assert.ok(columns.every(delta=>delta<=1),'Settings align with action icons');
  await page.screenshot({path:path.join(root,'.cache/chat-row-cli-actions.png')});
  await details.getByRole('button',{name:'CLI colors',exact:true}).click();await expect.poll(()=>service.coordinator.settings().terminalAppearance).toBe('original');
  await details.getByRole('button',{name:'Focus',exact:true}).click();await expect.poll(()=>service.coordinator.settings().terminalAppearance).toBe('focus');
  holdSettings=true;
  const font=details.getByRole('spinbutton',{name:'Terminal text size',exact:true});await font.fill('16');await font.press('Tab');await expect.poll(()=>service.coordinator.settings().terminalFontSize).toBe(16);
  await font.fill('');await font.press('Tab');await expect(font).toHaveValue('16');
  holdSettings=false;for(const deliver of heldSettings.splice(0))deliver();await expect.poll(()=>page.locator('.xterm-rows').evaluate(element=>getComputedStyle(element).fontSize)).toBe('16px');
  await font.fill('17');await header.getByRole('button',{name:'Attach files',exact:true}).focus();await expect.poll(()=>service.coordinator.settings().terminalFontSize).toBe(17);
  await font.fill('18');await page.locator('.project-chat-current strong').click();await expect.poll(()=>service.coordinator.settings().terminalFontSize).toBe(18);
  await details.locator('summary').click();await details.getByRole('tab',{name:'Actions',exact:true}).click();
  await font.fill('19');
  const olderFont=await fetch(`${service.origin}/api/settings`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({terminalFontSize:17})});assert.ok(olderFont.ok);
  await expect.poll(()=>page.locator('.xterm-rows').evaluate(element=>getComputedStyle(element).fontSize)).toBe('17px');
  await expect(font).toHaveValue('19');
  await page.locator('.project-chat-current strong').click();await expect.poll(()=>service.coordinator.settings().terminalFontSize).toBe(19);
  await details.locator('summary').click();await details.getByRole('tab',{name:'Actions',exact:true}).click();
  const color=details.getByRole('group',{name:'Tab color',exact:true}).locator('button').nth(2);await color.click();await expect(color).toHaveAttribute('aria-pressed','true');
  assert.equal(await color.evaluate(element=>getComputedStyle(element).outlineWidth),'2px');await expect(color.locator('svg')).toHaveCount(1);
  assert.equal(codex.process,codexProcess);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Hide operations',exact:true}).click();await expect(page.getByRole('button',{name:'Show operations',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Show operations',exact:true}).click();
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();
  const preferences=page.getByRole('dialog',{name:'Navigation preferences',exact:true});await expect(preferences.locator('select')).toHaveCount(0);
  await preferences.getByRole('button',{name:'Shortcuts',exact:true}).click();
  await expect(preferences.getByRole('textbox',{name:'New chat shortcut',exact:true})).toBeFocused();
  const shortcut=preferences.getByRole('textbox',{name:'New chat shortcut',exact:true});await shortcut.press('Control+Shift+P');await expect(preferences.getByRole('status')).toContainText('already assigned');await expect(shortcut).toHaveValue('Ctrl+Shift+T');
  await shortcut.press('Control+Alt+J');await expect(shortcut).toHaveValue('Ctrl+Alt+J');await page.keyboard.press('Escape');await page.reload();
  await page.locator('.xterm-helper-textarea').waitFor({state:'attached'});await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Control+Alt+j');await expect(page.locator('form.chat-create-dialog')).toBeVisible();await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();await preferences.getByRole('button',{name:'Shortcuts',exact:true}).click();await expect(preferences.getByRole('textbox',{name:'New chat shortcut',exact:true})).toHaveValue('Ctrl+Alt+J');await preferences.getByRole('button',{name:'Restore defaults',exact:true}).click();await page.keyboard.press('Escape');
  // Browser storage availability must not affect service-backed shortcuts.
  await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='mrmak.chat-shortcuts')throw new DOMException('Synthetic storage denial','SecurityError');return set.call(this,key,value)}});
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();await preferences.getByRole('button',{name:'Shortcuts',exact:true}).click();await preferences.getByRole('textbox',{name:'New chat shortcut',exact:true}).press('Control+Alt+L');await expect.poll(()=>service.coordinator.settings().chatShortcuts?.new).toBe('Ctrl+Alt+L');await page.keyboard.press('Escape');
  await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Control+Alt+l');await expect(page.locator('form.chat-create-dialog')).toBeVisible();await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Navigation preferences',exact:true}).click();await preferences.getByRole('button',{name:'Shortcuts',exact:true}).click();await expect(preferences.getByRole('textbox',{name:'New chat shortcut',exact:true})).toHaveValue('Ctrl+Alt+L');await preferences.getByRole('button',{name:'Restore defaults',exact:true}).click();await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 470, height: 580 });
  const button = page.getByRole('button', { name: 'Send typed CLI prompt', exact: true }); await button.waitFor();
  const box = await button.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 470);
  await writeFile(path.join(root,'.cache/chat-tweaks-terminal-geometry.json'),JSON.stringify(await page.locator('.terminal-host').evaluate(host=>[...host.querySelectorAll('[class]')].filter(element=>/viewport|scrollbar|scrollable|shadow/.test(element.className)).map(element=>{const b=element.getBoundingClientRect(),s=getComputedStyle(element);return{className:element.className,x:b.x,y:b.y,width:b.width,height:b.height,background:s.backgroundColor,overflowX:s.overflowX,display:s.display}})),null,2));
  for(const width of [1018,650,390,320]){
    await page.setViewportSize({width,height:780});
    const drawer=page.getByRole('complementary',{name:'Conversations by project'});if(await drawer.isVisible())await page.getByRole('button',{name:'Collapse project panel',exact:true}).click();
    await page.getByLabel('Chat details',{exact:true}).click();await page.getByRole('tab',{name:'Actions',exact:true}).click();
    const panel=await page.locator('.graphical-info-panel').boundingBox(),content=await page.locator('.project-chat-content').boundingBox();assert.ok(panel.x>=content.x&&panel.x+panel.width<=width+1,`CLI details avoid ancestor clipping at ${width}px: ${JSON.stringify(panel)}`);
    const tab=await details.getByRole('tab',{name:'Actions',exact:true}).boundingBox();assert.ok(tab.height>=34,'Tab underline stays below the label');
    await page.screenshot({path:path.join(root,`.cache/ui-refinement-cli-details-${width}.png`)});await page.keyboard.press('Escape');
    await page.locator('.cli-session-settings>summary').click();const picker=await page.locator('.cli-session-settings-panel').boundingBox();assert.ok(picker.x>=0&&picker.x+picker.width<=width+1,`CLI picker stays inside ${width}px`);await page.screenshot({path:path.join(root,`.cache/ui-refinement-cli-picker-${width}.png`)});await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: path.join(base, 'controls.png') }); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'CLI Send/Stop, Codex/Claude reasoning, Claude custom model menu, native fork dispatch/associations and narrow layout passed with fake PTYs.', screenshot: path.join(base, 'controls.png') }));
} finally {
  await browser?.close(); for (const session of service.sessions.items.values()) session.process = null; await service.close();
  await cleanupFixtures();
  if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaude;
}
