// Real keyboard input in a production build; synthetic providers/history only.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, createService, cleanupFixtures, testBrowserEnvironment } from './fixtures.mjs';
import { CodexChat } from '../codex-chat.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { graphicalFixture } from './codex-chat-fixture.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
const root = path.resolve('.'), base = await mkdtemp(path.join(os.tmpdir(), 'mik-chat-scroll-performance-'));
let service, browser;
const wires = [], measurements = [];
try {
  const uiDir = path.join(base, 'ui'), repo = path.join(base, 'hub'), home = path.join(base, 'home');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await mkdir(home); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: uiDir, emptyOutDir: false }, plugins: [{ name: 'chat-performance-counters', enforce: 'pre', transform(code, id) {
    const marker = id.endsWith('/GraphicalTimeline.tsx') ? '  const groups = useMemo' : id.endsWith('/ChatMarkdown.tsx') ? '  const components = useMemo' : null;
    if (!marker) return;
    const key = id.endsWith('/ChatMarkdown.tsx') ? 'markdown' : 'timeline';
    return code.replace(marker, `  if (globalThis.__chatPerformance) globalThis.__chatPerformance.${key}++;\n${marker}`);
  } }] });
  service = await createService({ repo, uiDir, mcpOptions: { home, env: { CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }, profileOptions: { root: path.join(base, 'accounts') } });
  service.sessions.verifyAccount = async () => {}; service.sessions.verifyIdentity = async () => {}; service.sessions.captureTools = async () => ({});
  const profile = await service.profiles.create('Performance fixture'), codex = graphicalFixture();
  service.sessions.createGraphicalRuntime = options => {
    if (options.session.agent === 'codex') return new CodexChat({ ...options, spawnChild: codex.spawnChild });
    const wire = claudeFixture(options.session.nativeId); wires.push(wire); return new ClaudeChat({ ...options, transportFactory: wire.factory });
  };
  browser = await chromium.launch({ headless: true, channel: process.env.MRMAK_TEST_BROWSER || 'chrome', env: testBrowserEnvironment() });
  const page = await browser.newPage({ viewport: { width: 480, height: 1000 } }), cdp = await page.context().newCDPSession(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__chatPerformance = { timeline: 0, markdown: 0, frames: [] };
    document.addEventListener('input', event => { if (event.target instanceof HTMLTextAreaElement) { const start = performance.now(); requestAnimationFrame(() => window.__chatPerformance.frames.push(performance.now() - start)); } }, true);
  });

  await cdp.send('Performance.enable');
  for (const agent of ['codex','claude']) for(const count of [200,2000]) for(const cpuSlowdown of [1,4]) {
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuSlowdown});
    const session=await service.sessions.create({agent,chatInterface:'chat',cwd:repo,name:`${agent} scroll ${count}`,accountProfileId:agent==='codex'?profile.id:undefined});
    const runtime=service.sessions.get(session.id).graphical;
    const all=[],turns=[];
    for(let i=0;i<count/2;i++){
      const turnId=`turn-${i}`;turns.push({id:turnId,status:'completed',startedAt:null,completedAt:null,durationMs:null,timingSource:'unavailable'});
      all.push({id:`question-${i}`,turnId,type:'userMessage',text:`Question ${i}`,details:'',status:'completed'});
      all.push({id:`progress-${i}`,turnId,type:'agentMessage',phase:'commentary',text:`Inspecting ${i}.\n\n`+'```typescript\n'+Array.from({length:16},(_,n)=>`const intermediate${n} = ${n};`).join('\n')+'\n```',details:'',status:'completed'});
      all.push({id:`answer-${i}`,turnId,type:'agentMessage',phase:'final_answer',text:`## Answer ${i}\n\n${'A paragraph with **important content** and links. '.repeat(8)}\n\n\`\`\`typescript\nconst answer = ${i};\n\`\`\``,details:'',status:'completed'});
    }
    if(agent==='codex'){runtime.items=new Map(all.map(item=>[item.id,item]));runtime.turns=new Map(turns.map(turn=>[turn.id,turn]));}else Object.assign(runtime.protocol.state,{items:all,turns,status:'ready'});
    const snapshot=runtime.snapshot.bind(runtime);runtime.snapshot=()=>({...snapshot(),items:all,turns,hasOlder:false});
    runtime.changed();await fetch(`${service.origin}/api/sessions/${session.id}/focus`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:'{}'});
    await page.goto(service.urls.chats);const view=page.locator('.graphical-messages');await expect(page.locator(`[data-chat-item="answer-${count/2-1}"]`)).toBeVisible();await page.waitForTimeout(350);
    const measure=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(m=>['ScriptDuration','LayoutDuration','RecalcStyleDuration'].includes(m.name)).map(m=>[m.name,m.value]));
    await page.evaluate(()=>{window.__chatPerformance={timeline:0,markdown:0,frames:[]}});
    const before=await measure();
    const frames=await view.evaluate(async element=>{
      const times=[];let last=performance.now();
      for(let n=0;n<64;n++){
        await new Promise(requestAnimationFrame);const now=performance.now();times.push(now-last);last=now;
        const top=n<32?-120:120;element.dispatchEvent(new WheelEvent('wheel',{deltaY:top,bubbles:true}));element.scrollBy({top,behavior:'instant'});
      }
      await new Promise(requestAnimationFrame);return times;
    });
    const after=await measure(),sample=await page.evaluate(()=>window.__chatPerformance);const ordered=[...frames].sort((a,b)=>a-b);
    measurements.push({agent,cpuSlowdown,logicalMessages:all.length,turns:turns.length,markdownRenders:sample.markdown,timelineRenders:sample.timeline,mountedMessages:await page.locator('.graphical-message').count(),closedProgressMarkdown:await page.locator('details.graphical-turn-process:not([open]) .chat-prose').count(),frameP95Ms:Math.round(ordered[Math.floor(ordered.length*.95)]),framesOver32ms:frames.filter(n=>n>32).length,scriptMs:Math.round((after.ScriptDuration-before.ScriptDuration)*1000),layoutMs:Math.round((after.LayoutDuration-before.LayoutDuration)*1000)});
    assert.ok(await page.locator('.graphical-message').count()<100,'Virtualized history remains bounded');
    if(process.argv.includes('--after')){assert.equal(measurements.at(-1).closedProgressMarkdown,0,'Closed steps do not mount Markdown');assert.ok(sample.markdown<200,'Scroll does not rebuild unchanged Markdown per frame')}
    console.log(JSON.stringify(measurements.at(-1)));
  }
  assert.deepEqual(errors,[]);assert.equal(codex.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(wires.flatMap(wire=>wire.calls).filter(call=>call.type==='user').length,0);
  const label=process.argv.includes('--after')?'after':'before';await writeFile(path.join(root,`.cache/chat-scroll-performance-${label}.json`),JSON.stringify({synthetic:true,workload:'64 animation frames, 120px up/down, production instrumented UI',measurements},null,2));
} finally {await browser?.close();await service?.close();for(const wire of wires)wire.close();await cleanupFixtures()}
