import test from 'node:test';
import assert from 'node:assert/strict';
import { messageResults, conversationResults } from '../chat-results.mjs';
test('results page older native history explicitly and omit raw source from the index', async () => {
  const item = { id: 'old', type: 'agentMessage', text: '```json\n{}\n```' }; let before;
  const runtime = { runtimeId: 'r', snapshot: () => ({ items: [], hasOlder: true }), older: async value => { before = value; return { items: [item], hasOlder: false }; } };
  const page = await conversationResults(runtime, { beforeId: 'boundary', cursor: 'cursor' });
  assert.deepEqual(before, { beforeId: 'boundary', cursor: 'cursor' }); assert.equal(page.results[0].text, undefined); assert.equal(page.beforeId, 'old'); assert.equal(page.hasOlder, false);
});

 test('native produced assets are indexed without indexing inputs, failed or source-only items',()=>{
 const image={id:'generated',type:'imageGeneration',status:'completed',path:'C:/fixture/icon.png'};
 assert.equal(messageResults(image)[0].type,'asset'); assert.equal(messageResults(image)[0].title,'icon.png');
 assert.notEqual(messageResults(image)[0].revision,messageResults({...image,path:'C:/fixture/new.png'})[0].revision);
 const tool={id:'tool',type:'mcpToolCall',resources:[{kind:'text',name:'Report',available:true,text:'one'},{kind:'unsupported',available:false}]};
 assert.equal(messageResults(tool).length,1);assert.equal(messageResults(tool)[0].resourceIndex,0);
 assert.deepEqual(messageResults({...image,type:'userMessage',text:'reference'}),[]);
 assert.deepEqual(messageResults({...image,status:'running'}),[]);
 });
