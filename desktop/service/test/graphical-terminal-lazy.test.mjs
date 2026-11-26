import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';

test('structured restore preserves terminal screens without hydrating them; explicit snapshot and CLI still work', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'mik-lazy-screen-'));
 const entries=[{id:'codex-chat',agent:'codex',chatInterface:'chat'},{id:'claude-chat',agent:'claude',chatInterface:'chat'},{id:'codex-cli',agent:'codex',chatInterface:'cli'}].map(row=>({...row,name:row.id,cwd:root,open:true,cols:90,rows:32}));
 await mkdir(path.join(root,'state'));const stateDir=path.join(root,'state');
 await writeFile(path.join(stateDir,'sessions.json'),JSON.stringify(entries));
 const screens=new Map();for(const row of entries){const bytes=JSON.stringify({data:`Retained ${row.id} screen\r\n> `});screens.set(row.id,bytes);await writeFile(path.join(stateDir,`screen-${row.id}.json`),bytes);}
 const sessions=await new Sessions(root,stateDir).init();
 try {
  assert.equal(sessions.get('codex-chat').terminal,null);assert.equal(sessions.get('claude-chat').terminal,null);assert.ok(sessions.get('codex-cli').terminal);
  await sessions.persist();
  for(const row of entries)assert.equal(await readFile(path.join(stateDir,`screen-${row.id}.json`),'utf8'),screens.get(row.id));
  const codex=await sessions.snapshot('codex-chat');assert.match(codex.data,/Retained codex-chat screen/);assert.ok(sessions.get('codex-chat').terminal);
  const claude=sessions.get('claude-chat');claude.graphical={snapshot:()=>({items:[{text:'Structured response'}]})};
  assert.match((await sessions.read(claude.id)).screen,/Structured response/);assert.equal(claude.terminal,null);
  claude.graphical=null;assert.match((await sessions.read(claude.id)).screen,/Retained claude-chat screen/);assert.ok(claude.terminal);
  await sessions.persist();
  for(const row of entries)assert.equal(await readFile(path.join(stateDir,`screen-${row.id}.json`),'utf8'),screens.get(row.id));
 } finally { await sessions.close(); }
});
