// Executable slider, isolation boundaries and state against production browser UI.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const base = await mkdtemp(path.join(os.tmpdir(), 'mik-structured-ui-')), root = path.resolve('.'), at = process.argv.indexOf('--portable'), portable = at < 0 ? null : path.resolve(process.argv[at + 1]);
const runtimeRoot = portable ? path.join(portable, 'App/runtime/service') : path.join(root, 'desktop/service');
const { createService: factory } = await import(pathToFileURL(path.join(runtimeRoot, 'server.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(runtimeRoot, 'codex-chat.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(runtimeRoot, 'claude-chat.mjs')));
let browser, service; const wires = [];
try {
 const repo = path.join(base, 'hub'), home = path.join(base, 'home'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
 service = await createService({ repo, uiDir: portable ? path.join(portable, 'App/runtime/ui') : path.join(root, 'dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } }, factory);
 service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
 const profile = await service.profiles.create('Interactive fixture'), codex = graphicalFixture();
 service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild }); const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
 browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
 const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }), page = await context.newPage(), workspace = await context.newPage();
 const errors = []; for (const tab of [page, workspace]) tab.on('pageerror', error => errors.push(error.message));
 await workspace.goto(service.urls.workspace);
 const json = JSON.stringify({ name: '<script>window.dataExecuted=true</script>', nested: { enabled: true }, items: Array.from({ length: 120 }, (_, index) => index) });
 const csv = 'name,note\nAda,"one, two"\nLin,"line one\nline two"', tsv = 'name\tvalue\nAda\t42';
 for (const [name, text] of [['data.json', json], ['data.csv', csv], ['data.tsv', tsv]]) await writeFile(path.join(repo, name), text);
 await writeFile(path.join(repo, 'large.json'), JSON.stringify({ payload: 'x'.repeat(200000) }));
 for (const agent of ['codex', 'claude']) {
  const session = await service.sessions.create({ agent, chatInterface: 'chat', cwd: repo, name: `${agent} structured`, ...(agent === 'codex' ? { accountProfileId: profile.id } : {}) }), runtime = service.sessions.get(session.id).graphical;
  const item = { id: 'structured', type: 'agentMessage', text: [['json', json], ['csv', csv], ['tsv', tsv], ['json', '{"incomplete"'], ['csv', 'name,value\n' + Array.from({ length: 125 }, (_, index) => `row ${index},${index}`).join('\n')]].map(([language, value]) => `\`\`\`${language}\n${value}\n\`\`\``).join('\n\n') + '\n\n[JSON file](data.json) · [CSV file](data.csv) · [TSV file](data.tsv) · [Large JSON file](large.json)', turnId: 'turn', status: 'completed', details: '' };
  if (agent === 'codex') runtime.items = new Map([[item.id, item]]); else runtime.protocol.state.items = [item]; runtime.changed();
  await fetch(`${service.origin}/api/sessions/${session.id}/focus`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); await page.goto(service.urls.chats);
  const chat = page.getByRole('region', { name: `${agent === 'codex' ? 'Codex' : 'Claude'} graphical chat`, exact: true }), blocks = chat.locator('.graphical-code'), tree = blocks.nth(0), draft = chat.locator('textarea').first(); await draft.fill('Keep structured draft');
  const evidence = [];
  await tree.scrollIntoViewIfNeeded();
  await tree.getByLabel('Output options', {exact:true}).click();
  const outputOptions = page.getByRole('dialog', { name: 'Output options', exact: true });
  const codeChoice = outputOptions.getByRole('button', {name:'Code',exact:true});
  await codeChoice.focus(); await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  await expect(tree.getByLabel('Output options',{exact:true})).toBeFocused();
  evidence.push({case:'output-action-focus', focus:await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),visible:document.activeElement?.checkVisibility()}))});
  await tree.getByLabel('Output options', {exact:true}).click();
  await outputOptions.getByRole('button',{name:'Data',exact:true}).click();
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('Synthetic clipboard denied')}}));
  await tree.locator('.structured-json-leaf').first().getByRole('button',{name:/Copy JSON value/}).click();
  await page.waitForTimeout(120);
  await expect(tree.locator('.structured-json-leaf').first().getByRole('button',{name:/Copy JSON value/}).getByRole('status')).toHaveText('Copy unavailable');
  await page.screenshot({path:path.join(root,`.cache/continued-${agent}-json-copy-feedback-after.png`)});
  assert.deepEqual(errors,[]);
  evidence.push({case:'json-copy-denied',errors:[...errors],feedback:await tree.locator('[role="status"]').allTextContents()});
  await page.evaluate(()=>{window.copiedJson=null;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.copiedJson=text}})});
  await tree.locator('.structured-json-leaf').first().getByRole('button',{name:/Copy JSON path/}).click();
  await expect(tree.locator('.structured-json-leaf').first().getByRole('button',{name:/Copy JSON path/}).getByRole('status')).toHaveText('Copied');
  assert.equal(await page.evaluate(()=>window.copiedJson),'$[\"name\"]');
  for(const size of [{width:390,height:640},{width:650,height:480}]) {
    await page.setViewportSize(size);
    const table=blocks.nth(1);await table.scrollIntoViewIfNeeded();
    await table.locator('.structured-table-tools > summary').click();
    await table.getByRole('button',{name:'Bar chart',exact:true}).click();
    evidence.push({case:'data-controls',size,geometry:await table.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth})),chat:await chat.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}))});
    await page.screenshot({path:path.join(root,`.cache/continued-ui-${agent}-${size.width}-structured-after.png`)});
    await table.locator('.structured-table-tools > summary').click();
  }
  console.log(agent,JSON.stringify(evidence,null,2));
 }
 assert.deepEqual(errors,[]);
 assert.equal(codex.calls.some(call=>call.method==='turn/start'),false);
 assert.equal(wires.flatMap(wire=>wire.calls).some(call=>call.type==='user'),false);
 console.log('PASS rich output keyboard focus, failed/successful JSON copy feedback, bounded data controls in both providers; zero inference.');
} finally { await browser?.close(); await service?.close(); for (const wire of wires) wire.close(); await cleanupFixtures(); }
