// Opt-in acceptance: opens and closes only its own isolated native application.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, copyFile, symlink, unlink, lstat, realpath, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
if(!process.argv.includes('--run'))throw new Error('Use --run to test the isolated native app. No real Hub or account is used.');
const root=path.resolve('.'),at=process.argv.indexOf('--portable'),portable=at<0?null:path.resolve(process.argv[at+1]);
const sourceRuntime=portable?path.join(portable,'App/runtime'):path.join(root,'.cache/desktop-runtime');
const sourceExe=portable?path.join(portable,'App/mrmak-workspace.exe'):path.join(root,'src-tauri/target-isolated/release/mrmak-workspace.exe');
const base=await mkdtemp(path.join(os.tmpdir(),'mik-native-window-layout-')),execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,ended,browser,linked=false,diagnostic='';
const app=path.join(base,'Portable/App'),hub=path.join(base,'Portable/MyHub'),runtimeLink=path.join(app,'runtime'),env={...process.env};
try{
  await mkdir(app,{recursive:true});await mkdir(path.join(hub,'workspace'),{recursive:true});await writeFile(path.join(hub,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
  await copyFile(sourceExe,path.join(app,'mrmak-workspace.exe'));await symlink(sourceRuntime,runtimeLink,'junction');linked=true;
  for(const name of ['APPDATA','LOCALAPPDATA','CODEX_HOME','CODEX_SQLITE_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){env[name]=path.join(base,name);await mkdir(env[name],{recursive:true})}
  for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_ACCESS_TOKEN'])delete env[name];
  env.WEBVIEW2_USER_DATA_FOLDER=path.join(base,'webview');env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';env.DISABLE_AUTOUPDATER='1';env.PATH=path.dirname(path.join(sourceRuntime,'node.exe'))+path.delimiter+env.PATH;
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  const exe=path.join(app,'mrmak-workspace.exe');child=spawn(exe,['--repo',hub],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{diagnostic=(diagnostic+data).slice(-3000)});ended=new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{diagnostic=error.message;resolve()})});
  const deadline=Date.now()+30000;let connected=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(`Isolated app exited before UI became ready (${child.exitCode}): ${diagnostic}`);try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){connected=true;break}}catch{}await pause(200)}
  assert.ok(connected,'Native WebView debugging endpoint became ready');browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let workspace;
  await expect.poll(()=>{workspace=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('surface=workspace'));return !!workspace},{timeout:20000}).toBe(true);
  await workspace.getByRole('button',{name:'Toggle settings',exact:true}).click();
  const section=workspace.getByRole('region',{name:'Window sizes',exact:true}),slider=section.getByRole('slider',{name:'Chats share of screen',exact:true});await expect(slider).toHaveValue('30');
  const probe=async()=>JSON.parse((await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'desktop/service/test/window-geometry.ps1'),'-OwnedProcessId',String(child.pid)],{windowsHide:true})).stdout.trim());
  const check=async percent=>{
    let report;
    await expect.poll(async()=>{
      report=await probe();const c=report.find(row=>row.label==='chats'),w=report.find(row=>row.label==='workspace');if(!c||!w)return false;
      const available=(c.workRight-c.workLeft)/(c.dpi/96)-4,expected=Math.max(330,Math.min(available-500,available*percent/100))/available;
      const actual=(c.right-c.left)/(c.right-c.left+w.right-w.left);
      return Math.abs(actual-expected)<.025&&Math.abs(w.left-c.right)<3&&Math.max(c.bottom,w.bottom)<=c.workBottom+3;
    },{timeout:12000,intervals:[200,500,1000]}).toBe(true);
    return report;
  };
  await section.getByRole('button',{name:'Apply window sizes',exact:true}).click();await check(30);console.log('Native 30/70 geometry passed.');
  await slider.focus();await slider.press('Home');for(let step=0;step<20;step++)await slider.press('ArrowRight');await expect(slider).toHaveValue('40');
  await section.getByRole('button',{name:'Apply window sizes',exact:true}).click();await expect(slider).toHaveValue('40');await check(40);console.log('Native 40/60 geometry passed.');
  await section.getByRole('button',{name:'30 / 70',exact:true}).click();await section.getByRole('button',{name:'Apply window sizes',exact:true}).click();await check(30);
  await workspace.screenshot({path:path.join(root,'.cache/native-window-layout-settings.png')});
  console.log('PASS actual native window geometry: 30/70 → 40/60 → 30/70, DPI-aware monitor bounds, adjacent painted edges and taskbar-safe height. No real Hub/login/model prompt.');
}catch(error){
  const logs=[];const scan=async folder=>{for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(folder,entry.name);if(entry.isDirectory())await scan(file);else if(entry.name==='service.log')logs.push((await readFile(file,'utf8')).slice(-2500))}};await scan(base);
  await writeFile(path.join(root,'.cache/native-window-layout-diagnostic.json'),JSON.stringify({exitCode:child?.exitCode,diagnostic,browserConnected:browser?.isConnected(),error:error.message,serviceLogs:logs},null,2));throw error;
}finally{
  if(child&&child.exitCode===null){try{await execute(path.join(app,'mrmak-workspace.exe'),['--repo',hub,'--quit'],{cwd:app,env,windowsHide:true,timeout:15000})}catch{}await Promise.race([ended,pause(5000)]);if(child.exitCode===null){child.kill();await ended}}
  await browser?.close().catch(()=>{});
  if(linked){assert.ok((await lstat(runtimeLink)).isSymbolicLink());assert.equal(await realpath(runtimeLink),await realpath(sourceRuntime));await unlink(runtimeLink)}
  await cleanupFixtures();
}
