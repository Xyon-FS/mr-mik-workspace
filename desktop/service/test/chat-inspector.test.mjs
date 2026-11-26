import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile, symlink } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { inspectItem, inspectFile, quoteRecordedDiff } from '../chat-inspector.mjs';
import { projectChatItem } from '../codex-chat-items.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-inspector-'));
  const r = { runtimeId: 'fixture-runtime', session: { id: 'fixture', cwd: root }, items: new Map(), historyItems: new Map(), previewPaths: new Set() };
  const put = item => { const publicItem = projectChatItem(item); delete publicItem.fullDetails; delete publicItem.fullResources; r.items.set(item.id, publicItem); return publicItem; };
  const request = (itemId, fileId = 'change-0', line = 1) => ({ itemId, fileId, line, version: inspectItem(r, itemId).version });
  return { root, r, put, request };
}

test('file inspection is read-only, version-bound and limited to authorized files', async () => {
  const { root, r, put, request } = await fixture(); const file = path.join(root, 'file.ts');
  const original = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n'); await writeFile(file, original);
  put({ id: 'changes', type: 'fileChange', status: 'completed', changes: [{ path: file, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }] });
  const current = await inspectFile(r, request('changes', 'change-0', 200)); assert.equal(current.status, 'ready'); assert.equal(current.line, 200); assert.equal(current.partial, true); assert.ok(current.lines.length <= 201);
  const invalid = await inspectFile(r, request('changes', 'change-0', 900)); assert.equal(invalid.status, 'line-missing');
  const stale = request('changes'); r.items.get('changes').status = 'failed'; await assert.rejects(inspectFile(r, stale), /changed/);
  await assert.rejects(inspectFile(r, { ...request('changes'), fileId: '../../other' }), /Choose/);
  await writeFile(file, Buffer.from([0, 1, 2])); assert.equal((await inspectFile(r, request('changes'))).status, 'binary');
  await writeFile(file, 'x'.repeat(1024 * 1024 + 1)); assert.equal((await inspectFile(r, request('changes'))).status, 'large');
  r.items.get('changes').changes[0].path = path.join(root, 'deleted.ts'); assert.equal((await inspectFile(r, request('changes'))).status, 'missing');

  const outside = await mkdtemp(path.join(os.tmpdir(), 'mik-inspector-outside-'));
  const alias = path.join(outside, 'project-alias');
  await symlink(root, alias, 'junction');
  r.session.cwd = alias;
  r.items.get('changes').changes[0].path = path.join(alias, 'file.ts');
  assert.equal((await inspectFile(r, request('changes'))).status, 'large');

  const attached = path.join(outside, 'safe.txt'); await writeFile(attached, 'Synthetic');
  put({ id: 'outside', type: 'fileChange', changes: [{ path: attached, kind: 'update', diff: '' }] });
  await assert.rejects(inspectFile(r, request('outside')), /outside/);
  r.previewPaths.add(attached); assert.equal((await inspectFile(r, request('outside'))).status, 'ready');
  const privateFile = path.join(root, '.env'); await writeFile(privateFile, 'SYNTHETIC=private'); r.items.get('outside').changes[0].path = privateFile;
  await assert.rejects(inspectFile(r, request('outside')), /Sensitive/);
  const junction = path.join(root, 'link'); await symlink(outside, junction, 'junction'); r.items.get('outside').changes[0].path = path.join(junction, 'safe.txt'); r.previewPaths.clear();
  await assert.rejects(inspectFile(r, request('outside')), /leaves/);
});

test('selected diff feedback is revision-bound, exact, bounded and never sent',async()=>{
 const {r,put,request}=await fixture();let changed=0;r.composer={items:[],changed:()=>changed++};
 put({id:'select',type:'fileChange',status:'completed',changes:[{path:'source.ts',kind:'update',diff:'@@ -1 +1 @@\n-old\n+new'}]});
 const input={...request('select'),runtimeId:r.runtimeId,start:1,end:2,text:'FORGED'};
 assert.equal(quoteRecordedDiff(r,input).submitted,false);assert.match(r.composer.items[0].text,/-old\n\+new/);assert.ok(!r.composer.items[0].text.includes('FORGED'));assert.equal(changed,1);
 quoteRecordedDiff(r,input);assert.equal(r.composer.items.length,1);
 assert.throws(()=>quoteRecordedDiff(r,{...input,runtimeId:'old'}),/changed/);assert.throws(()=>quoteRecordedDiff(r,{...input,version:'stale'}),/changed/);assert.throws(()=>quoteRecordedDiff(r,{...input,end:99}),/Select/);
 r.composer.assertEditable=()=>{throw Error('busy')};assert.throws(()=>quoteRecordedDiff(r,input),/busy/);
});

test('turn patch order is independent of the order in which cached history pages loaded', async () => {
  const { r, put } = await fixture();
  const later = put({ id: 'later', type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-2\n+3' }] });
  const earlier = put({ id: 'earlier', type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-1\n+2' }] });
  for (const edit of [later, earlier]) {
    edit.turnId = 'paged-turn';
    r.items.delete(edit.id);
    r.historyItems.set(edit.id, edit);
  }
  r.historyReferences = new Map([['earlier', { kind: 'older', beforeId: 'later' }]]);
  const latest = inspectItem(r, 'turn-changes:paged-turn').files[0];
  const patchValues = () => inspectItem(r, 'turn-changes:paged-turn').files[0].patches.map(patch => patch.rows[2].text);
  assert.deepEqual(patchValues(), ['+2', '+3']);
  r.historyReferences.clear();
  later.startedAt = 200;
  earlier.startedAt = 100;
  assert.deepEqual(patchValues(), ['+2', '+3']);
  earlier.changes[0].path = path.resolve(r.session.cwd, 'a.ts');
  const regrouped = inspectItem(r, 'turn-changes:paged-turn').files[0];
  assert.equal(regrouped.key, latest.key);
  assert.deepEqual(regrouped.patches.map(patch => patch.id), latest.patches.map(patch => patch.id));
});
