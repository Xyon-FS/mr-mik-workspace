// Explicit authenticated acceptance. Uses existing logins directly, never copies
// auth or prepares/migrates profiles. At most two short Luna/low prompts.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir, readFile, writeFile, realpath} from 'node:fs/promises';
import {Sessions} from '../sessions.mjs';
import {AccountProfiles} from '../account-profiles.mjs';
import {NativeProfileProbe} from '../codex-profile-probe.mjs';
import {graphicalCodexBinary} from '../codex-chat-binary.mjs';
import {CodexChatTransport} from '../codex-chat-transport.mjs';
import {mkdtemp,cleanupFixtures} from './fixtures.mjs';
if(!process.argv.includes('--authenticated'))throw new Error('Requires explicit --authenticated opt-in.');
const base=await mkdtemp(path.join(os.tmpdir(),'mik-auth-flow-')),hub=path.join(base,'hub');
const controls=process.argv.includes('--controls-only');
const report={authenticated:true,maxPrompts:controls?0:2,prompts:0,measurements:[],checks:[],cleanup:[],rpcPhases:[]};
const originalRpc=CodexChatTransport.prototype.rpc;
CodexChatTransport.prototype.rpc=async function(method,...args){const start=performance.now();try{return await originalRpc.call(this,method,...args);}finally{report.rpcPhases.push({method,ms:Math.round(performance.now()-start)});}};
const selection=JSON.parse(await readFile(path.resolve('.cache/real-codex-account-selection.json'),'utf8'));
const managers=new Map(),contexts=new Map(),owned=new Map();let sessions,stage='profile-inspection',failed;
const context=async id=>{
  const selected=selection.accounts.find(row=>row.profileId===id);assert.ok(selected,'Only selected acceptance profiles are permitted');
  let manager=managers.get(selected.registryRoot);
  if(!manager){manager=new AccountProfiles({root:selected.registryRoot});managers.set(selected.registryRoot,manager);}
  const ctx=await manager.inspectContext(id,hub);assert.ok(ctx,'The existing layout is not ready for read-only acceptance');
  contexts.set(id,{manager,context:ctx});return ctx;
};
async function measure(name,action){const start=performance.now();const value=await action();report.measurements.push({name,ms:Math.round(performance.now()-start)});return value;}
async function settle(runtime){
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){if(runtime.requests.size){for(const request of runtime.requests.values())if(!request.responded)runtime.answer(request.id,'cancel');throw new Error('The synthetic reply unexpectedly requested a tool approval');}
    if(!runtime.snapshot().working&&!runtime.submitting&&!runtime.advanced.dispatching)return;
    await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Synthetic reply did not settle within its bound');
}
async function prompt(session){
  const runtime=session.graphical;
  const luna=(await runtime.models()).find(model=>/luna/i.test(model.model+' '+model.displayName)&&model.supportedReasoningEfforts?.some(e=>e.reasoningEffort==='low'));
  assert.ok(luna,'A Luna model with low reasoning must be available');
  runtime.model=luna.model;session.graphicalModel=luna.model;session.effort='low';
  assert.ok(report.prompts<2);report.prompts++;
  await runtime.submit('Reply only OK. Do not use tools.');await settle(runtime);
  assert.ok([...runtime.items.values()].some(item=>item.type==='agentMessage'&&item.text?.trim()),'A real response must be visible');
  if(runtime.error)throw new Error('Native reply reported an error');
}
try{
  await mkdir(hub);assert.ok(selection.accounts.length,'No retained acceptance profiles');
  const a=selection.accounts[0];await context(a.profileId);
  sessions=await new Sessions(hub,path.join(base,'state')).init();sessions.codexWorkers.configure({maxIdle:1});
  sessions.accountContext=session=>context(session.accountProfileId);
  sessions.verifyIdentity=session=>contexts.get(session.accountProfileId).manager.assertIdentity(session.accountProfileId);
  sessions.verifyAccount=async(session,ctx)=>{
    await contexts.get(ctx.profileId).manager.assertIdentity(ctx.profileId);
    session.verifyStartupAccount=async runtime=>{
      const config=(await runtime.rpc('config/read',{cwd:hub})).config||{};
      assert.equal(config.cli_auth_credentials_store,'file');
      assert.equal((await realpath(config.sqlite_home)).toLowerCase(),ctx.sqliteHome.toLowerCase());
      assert.equal((await runtime.rpc('account/read',{refreshToken:false})).account?.type,'chatgpt');
      await contexts.get(ctx.profileId).manager.assertCurrentContext(ctx);
    };
  };
  sessions.permissionReady=session=>session.graphical?.ready()===true;
  let created;
  if(controls){
    const retained=JSON.parse(await readFile(path.resolve('.cache/chat-flow-authenticated-roots.json'),'utf8'));
    assert.equal(retained.length,1,'Control-only acceptance requires the exact root created by this diagnostic');
    owned.set(retained[0].nativeId,a.profileId);
    const ctx=contexts.get(a.profileId).context,probe=new NativeProfileProbe(hub,ctx.env,{binary:graphicalCodexBinary()});
    try{await probe.initialize();await probe.rpc('thread/unarchive',{threadId:retained[0].nativeId});}finally{await probe.close();}
    const restored=sessions.make({id:crypto.randomUUID(),agent:'codex',chatInterface:'chat',cwd:hub,accountProfileId:a.profileId,codexPermissions:'ask',effort:'low',name:'Isolated restored acceptance',nativeId:retained[0].nativeId,hasConversation:true,open:false,status:'stopped'});
    sessions.items.set(restored.id,restored);stage='cold-history-resume';created=await measure(stage,()=>sessions.resume(restored.id));
  }else{stage='cold-create';created=await measure(stage,()=>sessions.create({agent:'codex',chatInterface:'chat',cwd:hub,accountProfileId:a.profileId,codexPermissions:'ask',effort:'low',name:'Isolated chat-flow acceptance'}));}
  const session=sessions.get(created.id),nativeId=session.nativeId;owned.set(nativeId,a.profileId);
  if(!controls){stage='short-luna-reply';await measure(stage,()=>prompt(session));report.checks.push('Real Luna/low response rendered');}
  stage='close-owned-root';await measure(stage,()=>sessions.remove(created.id));
  stage='warm-history-resume';await measure(stage,()=>sessions.resume(created.id));
  assert.equal(session.nativeId,nativeId);assert.ok([...session.graphical.items.values()].some(item=>item.type==='agentMessage'&&item.text?.trim()));report.checks.push('History reopened original native root with visible response');
  if(selection.accounts.length>1){
    stage='account-switch';await measure(stage,()=>sessions.setAccountProfile(created.id,selection.accounts[1].profileId));
    assert.equal(session.nativeId,nativeId);assert.equal(session.accountProfileId,selection.accounts[1].profileId);report.checks.push('Real account switch retained native root and history');
    if(!controls){stage='second-account-luna-reply';await measure(stage,()=>prompt(session));report.checks.push('Real Luna/low response on second account');}
  }
  report.status='passed';
}catch(error){failed=error;report.status='failed';report.failedStage=stage;report.failureCategory=/quota|usage|limit/i.test(error.message)?'quota':/layout|profile|identity|account/i.test(error.message)?'account-or-layout':/Luna/i.test(error.message)?'low-cost-model-unavailable':'acceptance-error';}
finally{
  if(owned.size)await writeFile(path.resolve('.cache/chat-flow-authenticated-roots.json'),JSON.stringify([...owned].map(([nativeId,profileId])=>({nativeId,profileId})),null,2));
  await sessions?.close();
  // Archive only native roots created by this run. Original conversations and
  // logins are never removed. Retain the diagnostic IDs outside temp fixtures.
  for(const [nativeId,profileId]of owned){
    const ctx=contexts.get(profileId)?.context;if(!ctx)continue;
    const probe=new NativeProfileProbe(hub,ctx.env,{binary:graphicalCodexBinary()});
    try{await probe.initialize();await probe.rpc('thread/archive',{threadId:nativeId});report.cleanup.push({ownedRootArchived:true});}
    catch{report.cleanup.push({ownedRootArchived:false});}
    finally{await probe.close();}
  }
  await cleanupFixtures();CodexChatTransport.prototype.rpc=originalRpc;await writeFile(path.resolve(controls?'.cache/chat-flow-authenticated-controls.json':'.cache/chat-flow-authenticated.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));if(failed)process.exitCode=1;
