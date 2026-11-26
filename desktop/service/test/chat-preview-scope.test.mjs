import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {mkdtemp,createService} from './fixtures.mjs';

test('chat previews accept explicit external attachments and canonical generated roots without opening arbitrary external paths',async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'mik-image-scope-')),repo=path.join(base,'hub'),outside=path.join(base,'external'),home=path.join(base,'home');
 for(const folder of [path.join(repo,'workspace'),outside,home])await mkdir(folder,{recursive:true});
 await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
 const service=await createService({repo,mcpOptions:{home,env:{}}});t.after(()=>service.close());
 const file=path.join(outside,'attached.png');await writeFile(file,'synthetic image');
 const user={id:'user',type:'userMessage',attachments:[{path:file,kind:'image'}]},agent={id:'agent',type:'agentMessage',path:file};
 const runtime={items:new Map([[user.id,user],[agent.id,agent]]),historyItems:new Map(),previewPaths:new Set(),attachments:[file]};
 const session=service.sessions.make({id:'scope-fixture',agent:'codex',cwd:repo,chatInterface:'chat',status:'running',open:true});session.graphical=runtime;service.sessions.items.set(session.id,session);t.after(()=>service.sessions.items.delete(session.id));
 service.sessions.accountContext=async()=>null;
 const get=async query=>fetch(`${service.origin}/api/sessions/${session.id}/${query}`,{headers:{Authorization:'Bearer '+service.token}});
 let response=await get('chatimage?href='+encodeURIComponent(file));assert.equal(response.ok,false);
 response=await get('chatasset?item=user&attachment=0');assert.equal(response.ok,true,await response.text());runtime.previewPaths.clear();
 response=await get('chatasset?item=draft&attachment=0');assert.equal(response.ok,true);runtime.previewPaths.clear();
 response=await get('chatasset?item=agent');assert.equal(response.ok,false);
 const secret=path.join(outside,'auth.json');await writeFile(secret,'synthetic secret');user.attachments[0].path=secret;
 response=await get('chatfile?item=user&attachment=0');assert.equal(response.ok,false);
 response=await get('chatfile?item=user&attachment=0&preview=true');assert.equal(response.ok,false,'Preview mode never bypasses private-file guards');
 user.attachments[0].path=file;response=await get('chatfile?item=user&attachment=0&preview=true&expectedPath='+encodeURIComponent(secret));assert.equal(response.ok,false,'Changed attachment indexes fail closed');
 const attachmentQuery='chatfile?item=user&attachment=0&expectedPath='+encodeURIComponent(file);
 const post=query=>fetch(`${service.origin}/api/sessions/${session.id}/${query}`,{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{"action":"workspace"}'});
 response=await post(attachmentQuery); assert.equal(response.ok,true,await response.clone().text());
 response=await post('chatfile?item=user&attachment=0&expectedPath='+encodeURIComponent(secret)); assert.equal(response.ok,false);
 response=await post('chatfile?item=agent&attachment=0&expectedPath='+encodeURIComponent(file)); assert.equal(response.ok,false);
 const imagePreview=await (await get(attachmentQuery+'&preview=true')).json();
 assert.equal(imagePreview.kind,'image'); assert.match(imagePreview.url,/\/view\//);
 assert.equal(await (await fetch(imagePreview.url)).text(),'synthetic image');
 assert.equal((await fetch(new URL('auth.json',imagePreview.url))).ok,false);
 await writeFile(file,'updated synthetic image');
 assert.equal((await fetch(imagePreview.url)).status,409);
 runtime.previewPaths.clear();
 response=await get('chatfile?item=agent&preview=true');assert.equal(response.ok,false,'Preview mode never grants unrelated paths');
 const hidden=path.join(outside,'.hidden.pdf');await writeFile(hidden,'%PDF-1.4 synthetic');user.attachments[0].path=hidden;
 response=await get('chatfile?item=user&attachment=0&preview=true');assert.equal(response.ok,false,'A protected PDF must fail before opening an unusable viewer');assert.match((await response.json()).error,/Private application files/);
 const realGenerated=path.join(base,'real-generated'),alias=path.join(home,'generated_images');await mkdir(realGenerated);await symlink(realGenerated,alias,process.platform==='win32'?'junction':'dir');
 const generated=path.join(realGenerated,'generated.png');await writeFile(generated,'synthetic generated image');agent.path=path.join(alias,'generated.png');service.sessions.accountContext=async()=>({privateHome:home});
 response=await get('chatasset?item=agent');assert.equal(response.ok,true,await response.text());runtime.previewPaths.clear();
 const workspace=await service.projects.save({name:'Preview scope',repositoryPath:outside});session.projectId=workspace.id;session.repositoryId='hub';agent.path=file;
 response=await get('chatasset?item=agent');assert.equal(response.ok,true);runtime.previewPaths.clear();
 session.projectId=null;response=await get('chatasset?item=agent');assert.equal(response.ok,false,'Unrelated external paths stay blocked');
 const outsideCode=path.join(outside,'External.cs');await writeFile(outsideCode,'class External {}');
 session.process=runtime;
 try {
  response=await fetch(`${service.origin}/api/sessions/${session.id}/chat`,{
   method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},
   body:JSON.stringify({action:'open-file',href:outsideCode,destination:'ide'}),
  });
  assert.equal(response.ok,false);
  assert.match((await response.json()).error,/outside this chat/);
 } finally { session.process=null; }
});
