import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from './fixtures.mjs';
import { buildPortable } from '../../../scripts/build-portable.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-portable-build-'));
  for (const folder of ['node_modules/@tauri-apps/cli', 'node_modules/typescript/bin', 'desktop/service', 'dist', 'src-tauri/target-isolated/release']) await mkdir(path.join(root, folder), { recursive: true });
  for (const [file, text] of [['package.json','{"version":"1.2.3"}'],['node_modules/@tauri-apps/cli/tauri.js','fixture'],['node_modules/typescript/bin/tsc','fixture'],['desktop/service/server.mjs','current server'],['dist/index.html','current UI'],['src-tauri/target-isolated/release/mrmak-workspace.exe','current host']]) await writeFile(path.join(root,file),text);
  const messages = [], calls = [];
  const options = { root, info: message => messages.push(message) };
  const run = async (node, args, {env,log}) => {
    calls.push(path.basename(args[0]));log.write('fixture stage output\n');
    if (path.basename(args[0]) !== 'package-release.mjs') return;
    const folder = path.join(root,'release',`1.2.3-${env.MRMIK_RELEASE_SUFFIX}`), app = path.join(folder,'Mr-Mik-portable/App');
    await mkdir(path.join(app,'runtime'),{recursive:true});
    await cp(path.join(root,'desktop/service'),path.join(app,'runtime/service'),{recursive:true,filter:source=>path.basename(source)!=='test-live.mjs'});
    await cp(path.join(root,'dist'),path.join(app,'runtime/ui'),{recursive:true});
    await cp(path.join(root,'src-tauri/target-isolated/release/mrmak-workspace.exe'),path.join(app,'mrmak-workspace.exe'));
    await writeFile(path.join(folder,`Mr-Mik_1.2.3-${env.MRMIK_RELEASE_SUFFIX}_windows-x64_portable.zip`),'fixture archive');
  };
  return {root,options,run,calls,messages,lock:path.join(root,'.cache/manual-installer-build.lock')};
}

test('portable orchestration creates unique releases with logs and verifies current payload before reporting success', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'desktop/service/test-live.mjs'), 'Developer diagnostic');
  await buildPortable({ ...f.options, checkOnly: true, run: async () => assert.fail('Check-only must not launch a build command') });
  assert.equal((await readdir(f.root)).includes('release'), false);
  const first = await buildPortable({ ...f.options, run: f.run });
  const second = await buildPortable({ ...f.options, run: f.run });
  assert.notEqual(first.folder,second.folder);assert.equal(first.verified,2);
  assert.deepEqual(await readdir(path.join(first.folder, 'Mr-Mik-portable/App/runtime/service')), ['server.mjs']);
  assert.deepEqual(f.calls,['tauri.js','package-release.mjs','verify-release.mjs','tauri.js','package-release.mjs','verify-release.mjs']);
  assert.match(await readFile(first.log,'utf8'),/fixture stage output/);assert.match(await readFile(path.join(first.folder,'BUILD.txt'),'utf8'),/verification succeeded/);
  assert.equal((await readdir(path.join(f.root,'.cache'))).includes('manual-installer-build.lock'),false);
});
test('portable cannot overlap an installer build and never removes another build lock', async () => {
  const f=await fixture();await mkdir(path.dirname(f.lock),{recursive:true});await writeFile(f.lock,'existing owner');
  await assert.rejects(buildPortable({...f.options,run:f.run}),/build may already be running/);assert.equal(await readFile(f.lock,'utf8'),'existing owner');assert.deepEqual(f.calls,[]);
});
test('failed compilation aborts packaging, retains its log and releases its lock', async () => {
  const f=await fixture();let attempts=0;
  await assert.rejects(buildPortable({...f.options,run:async()=>{attempts++;throw new Error('fixture compile failure')}}),/fixture compile failure[\s\S]*Build log:/);
  assert.equal(attempts,1);assert.equal((await readdir(path.join(f.root,'.cache'))).includes('manual-installer-build.lock'),false);
  assert.equal(f.messages.some(message=>message.includes('SUCCESS')),false);
});
test('stale packaged UI is rejected before runtime checks and success output', async () => {
  const f=await fixture();await assert.rejects(buildPortable({...f.options,run:async(node,args,options)=>{
    await f.run(node,args,options);
    if(path.basename(args[0])==='package-release.mjs')await writeFile(path.join(f.root,'release',`1.2.3-${options.env.MRMIK_RELEASE_SUFFIX}`,'Mr-Mik-portable/App/runtime/ui/index.html'),'stale');
  }}),/stale file/);
  assert.deepEqual(f.calls,['tauri.js','package-release.mjs']);assert.equal(f.messages.some(message=>message.includes('SUCCESS')),false);
});
test('verification failure does not produce a successful build marker', async () => {
  const f=await fixture();await assert.rejects(buildPortable({...f.options,run:async(node,args,options)=>{await f.run(node,args,options);if(path.basename(args[0])==='verify-release.mjs')throw new Error('fixture runtime failure')}}),/runtime failure/);
  const [name]=await readdir(path.join(f.root,'release'));assert.equal((await readdir(path.join(f.root,'release',name))).includes('BUILD.txt'),false);
});
