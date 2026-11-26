import { seedSettings, exerciseSettings } from './settings-concept-ui.mjs';
import { seedTools, exerciseTools } from './tools-concept-ui.mjs';
import { seedSkills, exerciseSkills } from './skills-concept-ui.mjs';
// Opt-in acceptance: opens and closes only its own isolated native application.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, copyFile, symlink, unlink, lstat, realpath, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { seedWorkspaceFiles, exerciseWorkspaceFiles } from './workspace-files-ui.mjs';
import { exerciseWorkspaceFilesReview } from './workspace-files-review-ui.mjs';
import { exerciseWorkspaceVisuals } from './workspace-files-visual-ui.mjs';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
if(!process.argv.includes('--run'))throw new Error('Use --run to test the isolated native app. No real Hub or account is used.');
const root=path.resolve('.'),at=process.argv.indexOf('--portable'),portable=at<0?null:path.resolve(process.argv[at+1]);
const sourceRuntime=portable?path.join(portable,'App/runtime'):path.join(root,'.cache/desktop-runtime');
const sourceExe=portable?path.join(portable,'App/mrmak-workspace.exe'):path.join(root,'src-tauri/target-isolated/release/mrmak-workspace.exe');
const base=await mkdtemp(path.join(os.tmpdir(),'mik-native-window-layout-')),execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,ended,browser,diagnostic='';const links=[];
const app=path.join(base,'Portable/App'),hub=path.join(base,'Portable/MyHub'),runtimeLink=path.join(app,'runtime'),env={...process.env};
try{
  await mkdir(app,{recursive:true});for(const folder of ['workspace','context','knowledge','processes','inbox'])await mkdir(path.join(hub,folder),{recursive:true});await writeFile(path.join(hub,'workspace/workspace.json'),'{"entities":[],"resources":[]}');
  await copyFile(sourceExe,path.join(app,'mrmak-workspace.exe'));await mkdir(runtimeLink);await copyFile(path.join(sourceRuntime,'node.exe'),path.join(runtimeLink,'node.exe'));for(const [name,target] of [['service',portable?path.join(sourceRuntime,'service'):path.join(root,'desktop/service')],['ui',portable?path.join(sourceRuntime,'ui'):path.join(root,'dist')],['hub-template',path.join(sourceRuntime,'hub-template')]]){const link=path.join(runtimeLink,name);await symlink(target,link,'junction');links.push({link,target})}
  for(const name of ['APPDATA','LOCALAPPDATA','CODEX_HOME','CODEX_SQLITE_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']){env[name]=path.join(base,name);await mkdir(env[name],{recursive:true})}
  for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_ACCESS_TOKEN'])delete env[name];
  env.WEBVIEW2_USER_DATA_FOLDER=path.join(base,'webview');env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';env.DISABLE_AUTOUPDATER='1';env.PATH=path.dirname(path.join(sourceRuntime,'node.exe'))+path.delimiter+env.PATH;
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  delete env.Path;env.PATH=String(process.env.PATH||process.env.Path||'')+';C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  const exe=path.join(app,'mrmak-workspace.exe');child=spawn(exe,['--repo',hub],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{diagnostic=(diagnostic+data).slice(-3000)});ended=new Promise(resolve=>{child.once('exit',resolve);child.once('error',error=>{diagnostic=error.message;resolve()})});
  const deadline=Date.now()+30000;let connected=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(`Isolated app exited before UI became ready (${child.exitCode}): ${diagnostic}`);try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok){connected=true;break}}catch{}await pause(200)}
  assert.ok(connected,'Native WebView debugging endpoint became ready');browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  await expect.poll(()=>{page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('surface=workspace'));return !!page},{timeout:20000}).toBe(true);
  await page.waitForFunction(() => !!sessionStorage.getItem('mrmak.token'));
  await page.getByRole('button', { name: 'Toggle projects', exact: true }).waitFor();
  const request=async(route,data)=>page.evaluate(async({route,data})=>{const response=await fetch('/api'+route,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('mrmak.token'),'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw new Error(value.error||response.statusText);return value},{route,data});
  const service={projects:{save:data=>request('/projects',data),saveRepository:data=>request('/projects/repositories',data),createCard:data=>request('/cards',data),importResource:data=>request('/resources/import',data),assignResource:data=>request('/resources/assign',data),get:id=>request('/projects/'+id),setHubSkillScope:data=>request('/hub/skills/scope',data)}};
  const fixture=await seedWorkspaceFiles(service,hub,base);
  if(process.argv.includes('--settings')) { fixture.request=request; fixture.native=true; await seedSettings(fixture); await exerciseSettings(page,fixture); }
  else if(process.argv.includes('--tools')) { fixture.request=request; fixture.native=true; await seedTools(fixture); await exerciseTools(page,fixture); }
  else if(process.argv.includes('--skills')) { await seedSkills(fixture); await exerciseSkills(page,fixture); }
  else if(process.argv.includes('--visual')) await exerciseWorkspaceVisuals(page,fixture);
  else {
    await exerciseWorkspaceFilesReview(page,fixture);
    await page.reload(); await page.getByRole('button', { name: 'Toggle projects', exact: true }).waitFor();
    await exerciseWorkspaceFiles(page,fixture);
  }
  await page.screenshot({path:path.join(root,'.cache/workspace-files-native-app.png')});
  console.log('PASS actual Mr. Mik executable/WebView2: '+(process.argv.includes('--settings')?'Settings':process.argv.includes('--tools')?'Tools':process.argv.includes('--skills')?'Skills':'Workspace + Files')+' interactions, isolated service/Hub/accounts, no model calls.');
}catch(error){
  const logs=[];const scan=async folder=>{for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(folder,entry.name);if(entry.isDirectory())await scan(file);else if(entry.name==='service.log')logs.push((await readFile(file,'utf8')).slice(-2500))}};await scan(base);
  await writeFile(path.join(root,'.cache/workspace-files-native-diagnostic.json'),JSON.stringify({exitCode:child?.exitCode,diagnostic,browserConnected:browser?.isConnected(),error:error.message,serviceLogs:logs},null,2));throw error;
}finally{
  if(child&&child.exitCode===null){try{await execute(path.join(app,'mrmak-workspace.exe'),['--repo',hub,'--quit'],{cwd:app,env,windowsHide:true,timeout:15000})}catch{}await Promise.race([ended,pause(5000)]);if(child.exitCode===null){child.kill();await ended}}
  await browser?.close().catch(()=>{});
  for(const {link,target} of links){assert.ok((await lstat(link)).isSymbolicLink());assert.equal(await realpath(link),await realpath(target));await unlink(link)}
  await cleanupFixtures();
}
