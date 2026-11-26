import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ClaudeModelPicker, ClaudeEffortPicker } from '../claude-model-picker.mjs';
import { claudeTranscript, tailNativeFile } from '../native-events.mjs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import pty from '../node_modules/node-pty/lib/index.js';
import headless from '../node_modules/@xterm/headless/lib-headless/xterm-headless.js';
import { claudeBinary } from '../agents.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
let proc, terminal, exited, stop; const requests=[], nativeId=randomUUID();
const server=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(403);res.end('Synthetic fixture blocks inference');});
const screen=()=>terminal ? Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)||'').join('\n'):'';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const root=await mkdtemp(path.join(os.tmpdir(),'mik-claude-picker-')), cwd=path.join(root,'work');await mkdir(cwd);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(k)));
 for(const k of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CLAUDE_CONFIG_DIR']){env[k]=path.join(root,k);await mkdir(env[k]);}
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 Object.assign(env,{ANTHROPIC_API_KEY:'synthetic-picker-no-inference',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NO_PROXY:'127.0.0.1,localhost',TERM:'xterm-256color'});
 await writeFile(path.join(env.CLAUDE_CONFIG_DIR,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:'2.1.312',theme:'dark',customApiKeyResponses:{approved:['synthetic-picker-no-inference','synthetic-picker-no-inference'.slice(-20)],rejected:[]},projects:{[cwd]:{hasTrustDialogAccepted:true}}}));
 const binary=claudeBinary();terminal=new headless.Terminal({cols:120,rows:45,scrollback:200,allowProposedApi:true});
 proc=pty.spawn(binary.file,[...binary.args,'--session-id',nativeId,'--model','haiku','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{cwd,env,name:'xterm-256color',cols:120,rows:45,useConpty:true,useConptyDll:true});exited=new Promise(r=>proc.onExit(r));terminal.onData(data=>proc.write(data));proc.onData(data=>terminal.write(data));
 await pause(4000);if(screen().includes('Accessing workspace:')&&screen().includes(cwd)&&screen().includes('Yes, I trust this folder')){proc.write('\x1b[B');proc.write('\r');await pause(3500);}
 if(screen().includes('Do you want to use this API key?')&&screen().includes('picker-no-inference')){proc.write('\x1b[A');proc.write('\r');await pause(2500);}
 if(!/^\s*❯\s*$/m.test(screen()))throw new Error('No empty native prompt');
 const file=await claudeTranscript(cwd,nativeId,{home:env.CLAUDE_CONFIG_DIR});
 const session={agent:'claude',status:'running',activity:'idle',process:proc};
 stop=tailNativeFile(file,'claude',event=>{console.log('ACTIVITY',event.kind);session.activity=event.kind==='turn-started'?'working':'idle'});
 const sessions={get:()=>session,read:async()=>({screen:screen()}),input:(_id,key)=>proc.write(key),changed:()=>{},persist:async()=>{}};
 const models=new ClaudeModelPicker(sessions),efforts=new ClaudeEffortPicker(sessions);
 for(const [model,effort] of [['Sonnet','low'],['Haiku','medium'],['Sonnet','high']]){
   const menu=await models.open('native');await models.choose('native',menu.options.find(row=>row.label===model).slug);
   await pause(1100);assert.equal(session.activity,'idle');
   await efforts.openEffort('native');await efforts.chooseEffort('native',effort);
   await pause(1100);assert.equal(session.activity,'idle');console.log('PASS',model,effort,'idle after native transcript polling');
 }
 await models.open('native');await models.cancel('native');await pause(600);await efforts.openEffort('native');await efforts.cancelEffort('native');
 assert.equal(session.activity,'idle');assert.deepEqual(requests,[]);
 console.log(JSON.stringify({result:'PASS',modelChanges:3,effortChanges:3,reopenAndCancel:true,inferenceRequests:requests.length}));
}finally{stop?.();if(proc){try{proc.kill();}finally{proc._agent?._conoutSocketWorker?.dispose();}await exited;}terminal?.dispose();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));await cleanupFixtures();}
