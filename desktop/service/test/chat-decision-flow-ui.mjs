// Decision/recovery presentation with isolated service and synthetic providers.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';

const base = await mkdtemp(path.join(os.tmpdir(), 'mik-decision-flow-')), survey = process.argv.includes('--survey');
const wide = process.argv.includes('--wide');
const evidence = path.resolve('.cache', survey ? 'decision-flow-before' : wide ? 'decision-flow-wide' : 'decision-flow-after'), checks = [], wires = [];
let service, browser;
try {
  const repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home, env: { CODEX_HOME: path.join(home,'.codex'), CLAUDE_CONFIG_DIR: path.join(home,'.claude') } }, profileOptions: { root: path.join(base,'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Synthetic decisions'), wire = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => { if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: wire.spawnChild }); const f = claudeFixture(options.session.nativeId); wires.push(f); return new ClaudeChat({ ...options, transportFactory: f.factory }); };
  browser = await chromium.launch({ headless: true, channel:'chrome', env:testBrowserEnvironment() });
  const context = await browser.newContext({ viewport:{width:wide?1000:390,height:900}, permissions:['clipboard-read','clipboard-write'] }), page = await context.newPage(), errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  const check = (agent,name,passed) => checks.push({agent,name,passed});
  for (const agent of ['codex','claude']) {
    const session = await service.sessions.create({agent,chatInterface:'chat',cwd:repo,accountProfileId:agent==='codex'?profile.id:undefined}), runtime=service.sessions.get(session.id).graphical;
    const queueState=agent==='codex'?runtime.advanced:runtime.pending; queueState.paused=true;
    await queueState.enqueue('Queued review '+ 'detail '.repeat(150),randomUUID()); runtime.changed();
    await fetch(`${service.origin}/api/sessions/${session.id}/focus`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:'{}'});
    await page.goto(service.urls.chats);
    const chat=page.getByRole('region',{name:`${agent==='codex'?'Codex':'Claude'} graphical chat`,exact:true}), queue=chat.getByRole('region',{name:'Queued messages',exact:true}), entry=queue.locator('li').first();
    await expect(queue).toContainText('Queued review');
    check(agent,'long queued text has no nested scrollbar', await entry.locator('.graphical-queue-preview').evaluate(node=>node.scrollHeight<=node.clientHeight+1));
    const preview=entry.locator('.graphical-queue-message'); await preview.locator('summary').click();
    check(agent,'full queued text remains available on demand',await preview.locator('p').innerText()===queueState.queue[0].text);
    await queue.screenshot({path:path.join(evidence,`${agent}-queue-expanded.png`)});
    await preview.locator('summary').click();
    await entry.getByRole('button',{name:'Edit',exact:true}).click();
    await entry.getByRole('textbox',{name:'Edit queued message',exact:true}).fill('Edited review');
    let failSave = true;
    await page.route(url=>url.pathname.endsWith(`/sessions/${session.id}/chat`),async route=>{ if(failSave && route.request().postDataJSON()?.action==='queue-edit') { failSave=false; await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic queue save failed'})}); } else await route.fallback(); });
    await entry.getByRole('button',{name:'Save',exact:true}).click();
    await expect(chat.getByText('Synthetic queue save failed',{exact:false}).first()).toBeVisible();
    check(agent,'failed queue edit stays open',await entry.getByRole('textbox',{name:'Edit queued message',exact:true}).isVisible());
    check(agent,'queue failure is visible on its own entry',await entry.getByRole('alert').count()===1);
    await entry.screenshot({path:path.join(evidence,`${agent}-queue-error.png`)});
    if(!await entry.getByRole('textbox',{name:'Edit queued message',exact:true}).isVisible())await entry.getByRole('button',{name:'Edit',exact:true}).click();
    await entry.getByRole('button',{name:'Save',exact:true}).click(); await expect(entry).toContainText('Edited review');
    check(agent,'successful queue retry clears stale feedback',await chat.getByText('Synthetic queue save failed',{exact:false}).count()===0);
    queueState.queue[0].text='Current queued revision';runtime.changed();await expect(entry).toContainText('Current queued revision');
    await entry.getByRole('button',{name:'Edit',exact:true}).click();
    check(agent,'opening an editor uses the latest queue revision',await entry.getByRole('textbox',{name:'Edit queued message',exact:true}).inputValue()==='Current queued revision');
    await entry.getByRole('button',{name:'Cancel edit',exact:true}).click();
    if(agent==='codex') {
      const child=wire.children[0];
      child.request(701,'item/commandExecution/requestApproval',{threadId:runtime.threadId,command:'printf "**literal**" '+ 'argument'.repeat(80),availableDecisions:['decline','cancel']});
      const request=chat.getByRole('region',{name:'Agent request',exact:true}); await expect(request).toBeVisible();
      check(agent,'approval uses a human title instead of protocol text', !((await request.innerText()).includes('item/commandExecution/requestApproval')));
      check(agent,'requested command has a copy control',await request.getByRole('button',{name:'Copy requested command',exact:true}).count()===1);
      await request.getByRole('button',{name:'Copy requested command',exact:true}).click();
      check(agent,'command copy preserves the exact native payload',await page.evaluate(()=>navigator.clipboard.readText())==='printf "**literal**" '+ 'argument'.repeat(80));
      check(agent,'command preserves horizontal code formatting',await request.locator('pre').first().evaluate(node=>getComputedStyle(node).whiteSpace==='pre'));
      check(agent,'approval respects the native decision list',await request.getByRole('button',{name:'Allow once',exact:true}).count()===0);
      await request.screenshot({path:path.join(evidence,'approval.png')});
      await request.getByRole('button',{name:'Decline',exact:true}).click(); child.notify('serverRequest/resolved',{threadId:runtime.threadId,requestId:701}); await expect(request).toHaveCount(0);
      child.request(702,'item/tool/requestUserInput',{threadId:runtime.threadId,questions:[{id:'target',question:'Which synthetic folder?'}]});
      await request.getByRole('textbox',{name:'Which synthetic folder?',exact:true}).fill('Synthetic folder');
      await request.getByRole('button',{name:'Send answers',exact:true}).click(); await expect(request).toContainText('Response sent');
      check(agent,'answered fields are read only while awaiting provider',await request.getByRole('textbox',{name:'Which synthetic folder?',exact:true}).isDisabled());
      child.notify('serverRequest/resolved',{threadId:runtime.threadId,requestId:702}); await expect(request).toHaveCount(0);
      runtime.items.clear();runtime.turns.clear();runtime.turnId=null;
      runtime.upsert({id:'declined',type:'commandExecution',command:'native declined command',status:'declined',exitCode:1},{turnId:'stopped'});
      // Cancelled is an existing shared UI state; this is not a claim about a
      // new Codex protocol enum variant.
      runtime.upsert({id:'cancelled',type:'commandExecution',command:'shared cancelled command',status:'cancelled',exitCode:130},{turnId:'stopped'});
      runtime.upsert({id:'plan',type:'plan',plan:[{step:'Review '+ 'LongIdentifier'.repeat(60),status:'inProgress'},{step:'Verify the result',status:'pending'}]},{turnId:'plan-turn'});
      runtime.changed();
      await chat.locator('[data-chat-item="plan"]').waitFor({state:'attached'});
      for(const process of await chat.locator('.graphical-turn-process').all())if(!await process.evaluate(node=>node.open))await process.locator(':scope > summary').click();
      for(const group of await chat.locator('.graphical-work-group').all())if(!await group.evaluate(node=>node.open))await group.locator(':scope > summary').click();
      const stopped=chat.locator('[data-turn-id="stopped"]');
      check(agent,'declined and cancelled commands are not labelled failed',!((await stopped.innerText()).includes('Command failed'))&&await stopped.locator('.graphical-step.failed').count()===0);
      check(agent,'stopped group has no false all-failed aggregate',!((await stopped.innerText()).includes('Failed activity')));
      check(agent,'command summaries do not repeat the state',await stopped.locator('.graphical-step > summary > small').allTextContents().then(labels=>labels.every(label=>label.startsWith('Exit '))));
      const plan=chat.getByRole('region',{name:'Agent plan',exact:true});
      check(agent,'long plan step fits its container',await plan.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
      await plan.screenshot({path:path.join(evidence,'plan.png')}); await stopped.screenshot({path:path.join(evidence,'stopped.png')});
    }
    check(agent,'chat fits viewport',await chat.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    let failPause=true;
    await page.route(url=>url.pathname.endsWith(`/sessions/${session.id}/chat`),async route=>{if(failPause&&route.request().postDataJSON()?.action==='queue-pause'){failPause=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic pause failed'})});}else await route.fallback();});
    await queue.getByRole('button',{name:'Resume queue',exact:true}).click();
    await expect(queue.getByRole('alert')).toContainText('Synthetic pause failed');
    check(agent,'queue pause failure is visible and retry remains possible',await queue.getByRole('button',{name:'Resume queue',exact:true}).isEnabled());
  }
  assert.deepEqual(errors,[]); assert.ok(!wire.calls.some(call=>call.method==='turn/start'));
  assert.ok(wires.every(wire=>!wire.calls.some(call=>call.type==='user')));
  await writeFile(path.join(evidence,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
  if(!survey)assert.ok(checks.every(check=>check.passed));
} finally {await browser?.close();await service?.close();for(const wire of wires)await wire.close();await cleanupFixtures();}
