import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OpenCodeTransfer, validateOpenCode, openCodeHash, openCodeRelation, openCodeMembers } from '../opencode-transfer.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { NativeDeletion } from '../native-delete.mjs';
import { Sessions } from '../sessions.mjs';
import { partialTransferCases } from './partial-transfer-fixture.mjs';
partialTransferCases('OpenCode V1', hub, () => data());

const id = 'ses_ownedfixture';
test('full archive attachment approval is exact, expiring and single-use; imported media is self-contained', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-archive-media-')), source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const file = path.join(root, 'sample.png'); await writeFile(file, Buffer.from([1, 2, 3]));
    const original = data(); Object.assign(original.messages[0].parts[0], { type: 'file', mime: 'image/png', filename: 'sample.png', url: pathToFileURL(file).href });
    source.store.set(id, original);
    const chatId = randomUUID(); source.sessions.items.set(chatId, source.sessions.make({ id: chatId, agent: 'opencode', nativeId: id, name: 'Media fixture', cwd: source.repo, open: false, hasConversation: true }));
    await assert.rejects(source.archive.exportTo(root), /attachment/);
    let review = await source.archive.reviewExport(root); assert.equal(review.files.length, 1);
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token }), /not confirmed/);
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token, approveAttachments: true }), /expired/);
    review = await source.archive.reviewExport(root); source.archive.attachmentPlans.get(review.token).expires = 0;
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token, approveAttachments: true }), /expired/);
    review = await source.archive.reviewExport(root); await writeFile(file, 'changed');
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token, approveAttachments: true }), /changed/);
    review = await source.archive.reviewExport(root); source.store.get(id).messages[0].parts[0].filename = 'renamed.png';
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token, approveAttachments: true }), /conversation changed/);
    review = await source.archive.reviewExport(root);
    const exported = await source.archive.exportTo(root, { attachmentToken: review.token, approveAttachments: true });
    await target.archive.importFrom(exported.path, { relinks: {} });
    assert.equal(target.store.get(id).messages[0].parts[0].url, `data:image/png;base64,${Buffer.from('changed').toString('base64')}`);
    assert.equal(source.store.get(id).messages[0].parts[0].url, pathToFileURL(file).href);
    assert.equal(await readFile(file, 'utf8'), 'changed');
    assert.equal(openCodeRelation(original, target.store.get(id)), 'conflict');
  } finally { source.sessions.close(); target.sessions.close(); }
});
const data = () => ({ info: { id, projectID: 'global', directory: 'original', title: 'Fixture', slug: 'fixture', version: '1.18.34', time: { created: 1, updated: 1 } }, messages: [message('one', 1)] });
function message(suffix, created) { return { info: { id: `msg_${suffix}`, sessionID: id, role: 'user', time: { created } }, parts: [{ id: `prt_${suffix}`, sessionID: id, messageID: `msg_${suffix}`, type: 'text', text: suffix }] }; }
function family() {
  const root = data();
  root.children = ['child', 'grandchild'].map((suffix, index) => {
    const child = data(), childId = `ses_${suffix}`;
    child.info = { ...child.info, id: childId, parentID: index ? 'ses_child' : id, title: suffix };
    child.messages = [message(suffix, index + 2)];
    child.messages[0].info.sessionID = childId;
    Object.assign(child.messages[0].parts[0], { sessionID: childId, messageID: child.messages[0].info.id });
    return child;
  });
  return root;
}
function adapter(store) { return { read: async key => structuredClone(store.get(key) || null), write: async (value, cwd, hash) => { assert.equal(openCodeHash(store.get(value.info.id)), hash); store.set(value.info.id, { ...structuredClone(value), info: { ...value.info, directory: cwd } }); }, remove: async (key, hash) => { assert.equal(openCodeHash(store.get(key)), hash); store.delete(key); } }; }
async function hub(root, name) {
  const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
  for (const folder of ['workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [], resources: [] }));
  await writeFile(path.join(repo, 'projects/registry.json'), JSON.stringify({ projects: [] }));
  const sessions = await new Sessions(repo, stateDir).init(), archive = new PortableArchive(repo, stateDir, sessions, null), store = new Map();
  archive.openCode = adapter(store); return { repo, stateDir, sessions, archive, store };
}

test('OpenCode transfer validates ownership, portable attachments and exact semantic continuations, never timestamps alone', () => {
  const a = data(), b = data(); b.messages.push(message('two', 2)); b.info.time.updated = 2;
  assert.equal(openCodeRelation(a, b), 'update'); assert.equal(openCodeRelation(b, a), 'local-newer');
  const relocated = structuredClone(a); relocated.info.directory = 'other'; relocated.info.projectID = 'other';
  assert.equal(openCodeRelation(a, relocated), 'identical');
  const divergent = structuredClone(b); divergent.messages[0].parts[0].text = 'Changed';
  assert.equal(openCodeRelation(a, divergent), 'conflict');
  divergent.messages[0].parts[0].sessionID = 'ses_foreign'; assert.throws(() => validateOpenCode(divergent), /identity/);
  const attachment = data(); Object.assign(attachment.messages[0].parts[0], { type: 'file', url: 'file:///outside.png' }); assert.throws(() => validateOpenCode(attachment), /attachment/);
  attachment.messages[0].parts[0].url = 'data:image/png;base64,AAAA'; assert.ok(validateOpenCode(attachment));
  const child = data(); child.info.parentID = 'ses_parent'; assert.throws(() => validateOpenCode(child), /family/);
  const bookkeeping = structuredClone(a); bookkeeping.info.title = 'Native title'; bookkeeping.info.cost = 12; bookkeeping.todos = [];
  assert.equal(openCodeRelation(a, bookkeeping), 'identical');
  assert.notEqual(openCodeHash(a), openCodeHash(bookkeeping)); // Freshness remains stricter than ancestry.
  bookkeeping.info.revert = { messageID: 'msg_one' };
  assert.equal(openCodeRelation(a, bookkeeping), 'conflict');
});

test('OpenCode removal invokes native delete and refuses false success or a child-session race', async () => {
  const transfer = new OpenCodeTransfer('.');
  let current = data(), hasChildren = false, calls = 0, completes = false;
  transfer.read = async () => { transfer.revisions.set(id, 'revision'); return current; };
  transfer.familyRevision = () => hasChildren ? 'changed-family' : 'revision';
  transfer.database = async () => ({ prepare: () => ({ get: () => current ? { id } : undefined }), close() {} });
  transfer.command = async args => { assert.deepEqual(args, ['session', 'delete', id]); calls++; if (completes) current = null; };
  await assert.rejects(transfer.remove(id, null), /changed/);
  await assert.rejects(transfer.remove(id, openCodeHash(current)), /History entry has been retained/);
  assert.equal(calls, 1);
  hasChildren = true;
  await assert.rejects(transfer.remove(id, openCodeHash(current)), /family changed/);
  assert.equal(calls, 1);
  hasChildren = false; completes = true;
  await transfer.remove(id, openCodeHash(current));
  assert.equal(calls, 2);
});

test('OpenCode families validate complete topology, global identities, task references and same-folder bounds', () => {
  const root = family(); assert.equal(openCodeMembers(validateOpenCode(root)).length, 3);
  const reordered = structuredClone(root); reordered.children.reverse();
  assert.equal(openCodeHash(root), openCodeHash(reordered));
  assert.equal(openCodeRelation(root, reordered), 'identical');
  const cycle = family(); cycle.children[0].info.parentID = 'ses_grandchild'; assert.throws(() => validateOpenCode(cycle), /cycle/);
  const missing = family(); missing.children.pop(); missing.children[0].info.parentID = 'ses_missing'; assert.throws(() => validateOpenCode(missing), /parent/);
  const duplicate = family(); duplicate.children[0].messages[0].info.id = 'msg_one'; duplicate.children[0].messages[0].parts[0].messageID = 'msg_one'; assert.throws(() => validateOpenCode(duplicate), /across the family/);
  const otherFolder = family(); otherFolder.children[0].info.directory = 'outside'; assert.throws(() => validateOpenCode(otherFolder), /same working folder/);
  const reference = family(); reference.messages[0].parts.push({ id: 'prt_task', sessionID: id, messageID: 'msg_one', type: 'tool', tool: 'task', state: { metadata: { sessionId: 'ses_child' } } });
  assert.ok(validateOpenCode(reference)); reference.messages[0].parts[1].state.metadata.sessionId = 'ses_outside'; assert.throws(() => validateOpenCode(reference), /outside this family/);
  const nested = family(); nested.children[0].children = []; assert.throws(() => validateOpenCode(nested), /Nested/);
  const tooLarge = family(); tooLarge.children = Array.from({ length: 64 }, () => root.children[0]); assert.throws(() => validateOpenCode(tooLarge), /64-session/);
  const attachment = family(); Object.assign(attachment.children[0].messages[0].parts[0], { type: 'file', url: 'file:///outside.png' }); assert.throws(() => validateOpenCode(attachment), /attachment/);
});

test('OpenCode continuation decisions apply to the complete family, never a mixed partial merge', () => {
  const root = family(), next = family();
  const extra = message('child-next', 5); extra.info.sessionID = 'ses_child'; extra.parts[0].sessionID = 'ses_child'; next.children[0].messages.push(extra);
  assert.equal(openCodeRelation(root, next), 'update');
  assert.equal(openCodeRelation(next, root), 'local-newer');
  const divergent = structuredClone(next); divergent.children[1].messages[0].parts[0].text = 'Changed';
  assert.equal(openCodeRelation(root, divergent), 'conflict');
  const mixed = family(); mixed.messages.push(message('root-next', 6));
  assert.equal(openCodeRelation(next, mixed), 'conflict');
  const fewer = family(); fewer.children.pop(); assert.equal(openCodeRelation(root, fewer), 'local-newer');
  assert.equal(openCodeRelation(fewer, root), 'update');
});

test('OpenCode family preflight refuses a descendant ID owned by an unrelated native root without writes', async () => {
  const transfer = new OpenCodeTransfer('.');
  transfer.familyRevision = () => null;
  let closed = false;
  transfer.database = async () => ({ prepare: () => ({ get: key => key === 'ses_child' ? { id: key } : undefined }), close() { closed = true; } });
  await assert.rejects(transfer.inspect(family(), null), /child ID belongs to another/);
  assert.equal(closed, true);
});

test('OpenCode full archives bundle descendants without extra History entries and strip child permission/share state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-family-archive-')), source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const chatId = randomUUID(), native = family();
    for (const member of openCodeMembers(native)) Object.assign(member.info, { permission: [{ permission: '*', action: 'allow' }], share: { url: 'fixture-private-share' }, workspaceID: 'fixture-workspace' });
    source.sessions.items.set(chatId, source.sessions.make({ id: chatId, agent: 'opencode', nativeId: id, cwd: source.repo, name: 'Family', status: 'stopped', open: false, hasConversation: true })); source.store.set(id, native);
    const archive = await source.archive.exportTo(root), preview = await target.archive.preview(archive.path);
    assert.equal(archive.chats, 1); assert.equal(preview.native[0].familySize, 3);
    await target.archive.importFrom(archive.path); assert.equal(target.sessions.list().length, 1);
    for (const member of openCodeMembers(target.store.get(id))) { assert.equal(member.info.permission, undefined); assert.equal(member.info.share, undefined); assert.equal(member.info.workspaceID, undefined); }
    const next = family(); next.children[0].messages[0].parts[0].text = 'Divergent child'; source.store.set(id, next);
    const second = await source.archive.exportTo(root); assert.equal((await target.archive.preview(second.path)).native[0].status, 'conflict');
    await target.archive.importFrom(second.path); assert.equal(target.store.get(id).children[0].messages[0].parts[0].text, 'child');
  } finally { source.sessions.close(); target.sessions.close(); }
});

test('OpenCode deletion plans enumerate the family and reject separately referenced children or changed descendants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-family-delete-')), f = await hub(root, 'hub');
  try {
    const chatId = randomUUID(); f.sessions.items.set(chatId, f.sessions.make({ id: chatId, agent: 'opencode', nativeId: id, cwd: f.repo, name: 'Family', open: false })); f.store.set(id, family());
    const deletion = new NativeDeletion(f.sessions, f.stateDir); deletion.openCode = adapter(f.store);
    let plan = await deletion.plan(chatId); assert.deepEqual(plan.nativeSessions.map(member => member.id), [id, 'ses_child', 'ses_grandchild']);
    const duplicate = randomUUID(); f.sessions.items.set(duplicate, f.sessions.make({ id: duplicate, agent: 'opencode', nativeId: 'ses_grandchild', name: 'Child', open: true }));
    await assert.rejects(deletion.confirm(chatId, plan.token, 'Family'), /Another.*family/); f.sessions.items.delete(duplicate);
    plan = await deletion.plan(chatId); f.store.get(id).children[1].messages[0].parts[0].text = 'Changed';
    await assert.rejects(deletion.confirm(chatId, plan.token, 'Family'), /changed/);
    plan = await deletion.plan(chatId); await deletion.confirm(chatId, plan.token, 'Family'); assert.equal(f.store.has(id), false);
  } finally { f.sessions.close(); }
});

test('OpenCode full archives transfer only managed sessions, deduplicate, update continuations, preserve conflicts/backups and relocate History', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-archive-')), source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const chatId = randomUUID();
    const chat = { id: chatId, agent: 'opencode', nativeId: id, cwd: source.repo, name: 'Fixture', preview: 'Final answer excerpt', status: 'stopped', open: false, hasConversation: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    source.sessions.items.set(chatId, source.sessions.make(chat)); source.store.set(id, data());
    source.store.set('ses_notmanaged', { ...data(), info: { ...data().info, id: 'ses_notmanaged' } });
    const first = await source.archive.exportTo(root); assert.equal(first.chats, 1);
    assert.equal((await target.archive.preview(first.path)).native[0].status, 'new');
    await target.archive.importFrom(first.path); await target.archive.importFrom(first.path);
    assert.equal(target.store.size, 1); assert.equal(target.sessions.list().length, 1);
    assert.equal(target.sessions.list()[0].cwd, target.repo);
    assert.equal(target.sessions.list()[0].preview, 'Final answer excerpt');
    const next = data(); next.messages.push(message('two', 2)); source.store.set(id, next);
    const second = await source.archive.exportTo(root);
    assert.equal((await target.archive.preview(second.path)).native[0].status, 'update');
    const updated = await target.archive.importFrom(second.path); assert.equal(updated.nativeUpdated, 1); assert.equal(updated.sessionsUpdated, 1);
    assert.equal(JSON.parse(await readFile(path.join(updated.backup, 'native/opencode', `${id}.json`), 'utf8')).messages.length, 1);
    const divergence = structuredClone(next); divergence.messages[0].parts[0].text = 'Local divergence'; target.store.set(id, divergence);
    assert.equal((await target.archive.preview(second.path)).native[0].status, 'conflict');
    assert.equal((await target.archive.importFrom(second.path)).nativeSkipped, 1); assert.equal(target.store.get(id).messages[0].parts[0].text, 'Local divergence');
    await assert.rejects(target.archive.importFrom(second.path, { replaceNative: [`opencode:${id}`] }), /cannot be overwritten/);
    assert.equal(target.store.get(id).messages[0].parts[0].text, 'Local divergence');
    target.sessions.items.clear();
    await target.archive.importFrom(second.path);
    assert.equal(target.sessions.list().length, 0); // Do not attach the incoming screen to unrelated local content.
  } finally { source.sessions.close(); target.sessions.close(); }
});

test('OpenCode native deletion requires a closed unique managed chat, exact name and unchanged native data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-oc-delete-')), f = await hub(root, 'hub');
  try {
    const chatId = randomUUID(), chat = f.sessions.make({ id: chatId, agent: 'opencode', nativeId: id, name: 'Fixture', cwd: f.repo, open: false });
    f.sessions.items.set(chatId, chat); f.store.set(id, data()); f.store.set('ses_unrelated', data());
    const deletion = new NativeDeletion(f.sessions, f.stateDir); deletion.openCode = adapter(f.store);
    chat.open = true; await assert.rejects(deletion.plan(chatId), /Close/); chat.open = false;
    let plan = await deletion.plan(chatId); await assert.rejects(deletion.confirm(chatId, plan.token, 'Wrong'), /match/);
    plan = await deletion.plan(chatId); f.store.get(id).messages[0].parts[0].text = 'Changed'; await assert.rejects(deletion.confirm(chatId, plan.token, 'Fixture'), /changed/);
    const duplicateId = randomUUID(); f.sessions.items.set(duplicateId, f.sessions.make({ ...chat, id: duplicateId })); await assert.rejects(deletion.plan(chatId), /Another/); f.sessions.items.delete(duplicateId);
    plan = await deletion.plan(chatId); assert.equal((await deletion.confirm(chatId, plan.token, 'Fixture')).deleted, true);
    assert.equal(f.store.has(id), false); assert.equal(f.store.has('ses_unrelated'), true); assert.equal(f.sessions.items.has(chatId), false);
  } finally { f.sessions.close(); }
});
