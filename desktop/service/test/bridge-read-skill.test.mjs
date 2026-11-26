import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,createService} from './fixtures.mjs';
import { bridgeTools } from '../workspace-bridge.mjs';

test('real MCP skill reads accept the screenshot argument while preserving workspace/provider/disabled scopes',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'mik-read-hub-skill-')),repo=path.join(base,'hub'),home=path.join(base,'home');
 await mkdir(path.join(repo,'workspace'),{recursive:true});await mkdir(home);await writeFile(path.join(repo,'workspace/workspace.json'),'{"entities":[]}');
 for(const [folder,label] of [['.agents','Codex'],['.claude','Claude']]){const root=path.join(repo,folder,'skills','feature-handoff');await mkdir(root,{recursive:true});await writeFile(path.join(root,'SKILL.md'),`---\nname: feature-handoff\ndescription: Synthetic handoff.\n---\n# ${label} handoff fixture\n`);}
 const service=await createService({repo,mcpOptions:{home,env:{}},profileOptions:{root:path.join(base,'accounts')}});
 try{
  const project=await service.projects.save({name:'Synthetic workspace'});
  for(const agent of ['codex','claude']){
   await service.projects.setHubSkillScope({id:'feature-handoff',scope:'project',projectId:project.id,enabled:true,agent});
   const owner=`fixture-${agent}`,token=service.bridge.issue(owner,project.id,null,null,agent),client=new Client({name:'skill-reader-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bridge-mcp.mjs',import.meta.url))],env:{...process.env,MRMAK_BRIDGE_URL:`${service.origin}/bridge`,MRMAK_BRIDGE_TOKEN:token},stderr:'ignore'});
   try{
    await client.connect(transport);assert.match(client.getInstructions(),/mrmak_read_hub_skill\(\{"id":"feature-handoff"\}\)/);
    const input = { skillId: 'feature-handoff' };
    const readSkill = args => service.bridge.call(token, 'mrmak_read_hub_skill', args);
    assert.equal((await readSkill(input)).id, 'feature-handoff');
    assert.deepEqual(input, { skillId: 'feature-handoff' });
    assert.equal((await readSkill({ id: 'feature-handoff', ...input })).id, 'feature-handoff');
    for (const args of [{}, { id: '' }, { id: 1 }, { skillId: null }]) await assert.rejects(readSkill(args), /requires a non-empty/);
    await assert.rejects(readSkill({ ...input, unexpected: true }), /Unsupported Bridge/);
    await assert.rejects(service.bridge.call(token, 'mrmak_read_card', input), /Unsupported Bridge/);
    assert.deepEqual(bridgeTools.find(tool => tool.name === 'mrmak_read_hub_skill').inputSchema.required, ['id']);
    const result=await client.callTool({name:'mrmak_read_hub_skill',arguments:{skillId:'feature-handoff'}});assert.notEqual(result.isError,true);assert.match(result.content[0].text,new RegExp(`${agent==='codex'?'Codex':'Claude'} handoff fixture`));
    await service.projects.setHubSkillScope({id:'feature-handoff',scope:'project',projectId:project.id,enabled:false,agent});
    const denied=await client.callTool({name:'mrmak_read_hub_skill',arguments:{skillId:'feature-handoff'}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/not enabled/);
    const conflict=await client.callTool({name:'mrmak_read_hub_skill',arguments:{id:'one',skillId:'two'}});assert.equal(conflict.isError,true);assert.match(conflict.content[0].text,/conflicting/);
    const missing=await client.callTool({name:'mrmak_read_hub_skill',arguments:{}});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/requires a non-empty/);
    service.bridge.revoke(owner);assert.equal((await client.callTool({name:'mrmak_read_hub_skill',arguments:{skillId:'feature-handoff'}})).isError,true);
   }finally{await client.close();await transport.close();}
  }
 }finally{await service.close();}
});
