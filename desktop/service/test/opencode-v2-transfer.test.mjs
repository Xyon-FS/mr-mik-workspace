import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { OpenCodeV2Transfer, validateV2Transfer, v2Members } from '../opencode-v2-transfer.mjs';
import { validateOpenCode, openCodeRelation, openCodeHash, openCodeIdentities } from '../opencode-transfer.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { NativeDeletion } from '../native-delete.mjs';
import { Sessions } from '../sessions.mjs';
import { Projects } from '../projects.mjs';
import { pathToFileURL } from 'node:url';
import { partialTransferCases } from './partial-transfer-fixture.mjs';
partialTransferCases('OpenCode V2', hub, () => data());

const data = () => ({ format: 'opencode-v2', info: { id: 'ses_v2fixture', title: 'Fixture', location: { directory: '/fixture' }, time: { created: 1, updated: 2 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, messages: [{ id: 'msg_v2fixture', type: 'user', text: 'Fixture', time: { created: 1 } }] });

test('V2 native format is discriminated; typed message identities, no timestamp overwrite, dependency and attachment guards', () => {
  const base = data(); validateOpenCode(base);
  assert.deepEqual(openCodeIdentities(base), ['ses_v2fixture', 'msg_v2fixture']);
  const relocated = structuredClone(base); relocated.info.location.directory = '/another-pc'; relocated.info.time.updated = 9000;
  assert.equal(openCodeRelation(base, relocated), 'identical'); assert.equal(openCodeHash(base), openCodeHash(relocated));
  const next = structuredClone(base); next.messages.push({ id: 'msg_next', type: 'user', text: 'Next', time: { created: 2 } });
  assert.equal(openCodeRelation(base, next), 'update'); assert.equal(openCodeRelation(next, base), 'local-newer');
  assert.throws(() => validateV2Transfer({ ...base, info: { ...base.info, fork: { sessionID: 'ses_parent' } } }), /dependencies/);
  assert.throws(() => validateV2Transfer({ ...base, messages: [{ ...base.messages[0], files: [{ data: '', source: { type: 'file', path: '/external' } }] }] }), /external/);
  assert.throws(() => validateV2Transfer({ ...base, messages: [{ id: 'msg_running', type: 'assistant', content: [], time: { created: 1 } }] }), /settled/);
  assert.throws(() => validateV2Transfer({ ...base, messages: [base.messages[0], base.messages[0]] }), /identity/);
  assert.throws(() => validateV2Transfer({ ...base, messages: [{ ...base.messages[0], type: 'location-switched' }] }), /cross-folder/);
});

test('V2 divergent histories never invoke native delete/import to bypass a conflict', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-transfer-guard-'));
  try {
    const transfer = new OpenCodeV2Transfer(base); transfer.read = async () => data();
    transfer.command = async () => assert.fail('No native mutation on duplicate/conflict');
    const original = data(); await transfer.write(original, base, openCodeHash(original));
    const next = data(); next.messages.push({ id: 'msg_next', type: 'user', text: 'Next', time: { created: 2 } });
    next.messages[0].text = 'Divergent';
    await assert.rejects(transfer.write(next, base, openCodeHash(original)), /cannot overwrite/);
    await assert.rejects(transfer.remove(original.info.id, 'stale'), /changed/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('V2 prompt provenance normalization deduplicates by stored bytes without resolving external tool URIs', () => {
  const local = data(); local.messages[0].files = [{ data: 'AQID', mime: 'image/png', source: { type: 'uri', uri: 'file:///missing.png' } }];
  const portable = structuredClone(local); portable.messages[0].files[0].source = { type: 'inline' };
  assert.equal(openCodeRelation(local, portable), 'identical'); assert.equal(openCodeHash(local), openCodeHash(portable));
  portable.messages[0].files[0].data = 'BAUG'; assert.equal(openCodeRelation(local, portable), 'conflict');
});

async function hub(root, name) {
  const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
  await mkdir(path.join(repo, 'workspace'), { recursive: true }); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  await mkdir(path.join(repo, 'projects'), { recursive: true }); await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
  const sessions = await new Sessions(repo, stateDir).init(), archive = new PortableArchive(repo, stateDir, sessions, new Projects(repo, stateDir)), store = new Map();
  archive.openCode = {
    read: async id => structuredClone(store.get(id) || null), inspect: async () => {},
    write: async (value, cwd, expected) => { assert.equal(openCodeHash(store.get(value.info.id) || null), expected); const copied = structuredClone(value); for (const member of v2Members(copied)) member.info.location.directory = cwd; store.set(value.info.id, copied); },
  };
  return { repo, stateDir, sessions, archive, store };
}

test('V2 full archives require explicit tool-file approval and import self-contained historical media', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-media-archive-'));
  let source, target;
  try {
    source = await hub(root, 'source'); target = await hub(root, 'target');
    const native = data(), file = path.join(root, 'tool.png'); await writeFile(file, Buffer.from([1, 2, 3]));
    native.info.location.directory = source.repo;
    native.messages[0].files = [{ data: 'BAUG', mime: 'image/png', source: { type: 'uri', uri: 'file:///missing-historical.png' } }];
    native.messages.push({ id: 'msg_media', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'tool', name: 'fixture', state: { status: 'completed', input: {}, content: [{ type: 'file', uri: pathToFileURL(file).href, mime: 'image/png' }] } }] });
    source.store.set(native.info.id, native);
    const id = randomUUID();
    source.sessions.items.set(id, source.sessions.make({ id, agent: 'opencode', nativeId: native.info.id, cwd: source.repo, name: 'Media', hasConversation: true, open: false, createdAt: new Date().toISOString() }));
    await assert.rejects(source.archive.exportTo(root), /not approved/);
    const unapproved = await source.archive.reviewExport(root); assert.equal(unapproved.files.length, 1);
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: unapproved.token }), /not confirmed/);
    const plan = await source.archive.reviewExport(root);
    const exported = await source.archive.exportTo(root, { attachmentToken: plan.token, approveAttachments: true });
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: plan.token, approveAttachments: true }), /expired/);
    await rm(file);
    await target.archive.importFrom(exported.path);
    const imported = target.store.get(native.info.id);
    assert.equal(imported.messages[0].files[0].data, 'BAUG');
    assert.deepEqual(imported.messages[0].files[0].source, { type: 'inline' });
    assert.equal(imported.messages[1].content[0].state.content[0].uri, 'data:image/png;base64,AQID');
    assert.equal(source.store.get(native.info.id).messages[0].files[0].source.type, 'uri');
  } finally { await source?.sessions.close(); await target?.sessions.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('V2 full archive relinks typed native content, deduplicates, preserves local continuations and excludes unmapped native chats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-archive-'));
  let source, target;
  try {
    source = await hub(root, 'source'); target = await hub(root, 'target');
    const id = randomUUID(), native = data(); native.info.location.directory = source.repo; native.info.permissions = [{ action: '*', resource: '*', effect: 'allow' }];
    source.store.set(native.info.id, native); source.store.set('ses_unmanaged', data());
    source.sessions.items.set(id, source.sessions.make({ id, agent: 'opencode', nativeId: native.info.id, cwd: source.repo, name: 'Fixture', hasConversation: true, open: false, createdAt: new Date().toISOString() }));
    const exported = await source.archive.exportTo(root);
    assert.equal((await target.archive.preview(exported.path)).native[0].status, 'new');
    await target.archive.importFrom(exported.path);
    assert.equal(target.store.size, 1); assert.equal(target.store.get(native.info.id).info.location.directory, target.repo); assert.equal(target.store.get(native.info.id).info.permissions, undefined);
    assert.equal((await target.archive.preview(exported.path)).native[0].status, 'identical');
    await target.archive.importFrom(exported.path); assert.equal(target.sessions.list().length, 1);
    native.messages.push({ id: 'msg_next', type: 'user', text: 'Continuation', time: { created: 3 } }); source.store.set(native.info.id, native);
    const newer = await source.archive.exportTo(root);
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'update');
    const result = await target.archive.importFrom(newer.path); assert.equal(result.nativeUpdated, 1); assert.equal(target.store.get(native.info.id).messages.length, 2);
    native.messages[0].text = 'Divergent'; source.store.set(native.info.id, native);
    const divergent = await source.archive.exportTo(root);
    assert.equal((await target.archive.preview(divergent.path)).native[0].status, 'conflict');
    assert.equal((await target.archive.importFrom(divergent.path)).nativeSkipped, 1);
    const deletion = new NativeDeletion(target.sessions, target.stateDir); deletion.openCode = { ...target.archive.openCode, remove: async (nativeId, hash) => { assert.equal(hash, openCodeHash(target.store.get(nativeId))); target.store.delete(nativeId); } };
    const plan = await deletion.plan(id); assert.match(plan.warning, /deleted recursively/); await deletion.confirm(id, plan.token, 'Fixture');
    assert.equal(target.sessions.list().length, 0); assert.equal(target.store.size, 0); assert.ok(source.store.has(native.info.id));
  } finally { await source?.sessions.close(); await target?.sessions.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

async function replacementFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mik-v2-replace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = data(); local.info.location.directory = root; local.info.permissions = [{ action: 'skill', resource: '*', effect: 'ask' }];
  const incoming = structuredClone(local); incoming.info.permissions = [{ action: '*', resource: '*', effect: 'allow' }]; incoming.messages.push({ id: 'msg_next', type: 'user', text: 'Next', time: { created: 3 } });
  let stored = structuredClone(local), deletes = 0, fail = false;
  const transfer = new OpenCodeV2Transfer(root);
  transfer.read = async () => structuredClone(stored);
  transfer.inspect = async () => {};
  transfer.databasePath = async () => path.join(root, 'fixture.db');
  transfer.validateImport = async () => {};
  transfer.command = async (args, directory) => {
    if (args[1] === 'delete') { deletes++; stored = null; return ''; }
    if (args[1] === 'import') {
      if (fail) { fail = false; throw new Error('fixture failure'); }
      const native = JSON.parse(await readFile(args[2], 'utf8')); stored = { format: 'opencode-v2', ...native }; stored.info.location.directory = directory;
      return `Imported session: ${native.info.id}`;
    }
    assert.fail('Unexpected native command');
  };
  return { root, local, incoming, transfer, get stored() { return stored; }, get deletes() { return deletes; }, failImport() { fail = true; } };
}

test('V2 compatible replacement persists a recovery backup before deletion and preserves local permissions', async t => {
  const f = await replacementFixture(t);
  const result = await f.transfer.write(f.incoming, f.root, openCodeHash(f.local));
  assert.equal(f.stored.messages.length, 2); assert.deepEqual(f.stored.info.permissions, f.local.info.permissions); assert.equal(f.deletes, 1);
  assert.deepEqual(JSON.parse(await readFile(result.backup, 'utf8')), f.local);
});

test('V2 failed incoming import restores the exact original transcript and local policy', async t => {
  const f = await replacementFixture(t); f.failImport();
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.local)), /original conversation was restored/);
  assert.deepEqual(f.stored, f.local); assert.equal(f.deletes, 1);
  assert.equal((await readdir(path.join(f.root, '.mrmak/import-backups/opencode-v2'))).length, 1);
});

test('V2 rollback prevalidation and changed-chat checks stop before destructive commands', async t => {
  const f = await replacementFixture(t);
  f.transfer.validateImport = async (file, data, working, temp, name) => { if (name === 'rollback') throw new Error('restore not supported'); };
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.local)), /restore not supported/); assert.equal(f.deletes, 0);
  f.transfer.validateImport = async () => { f.local.info.title = 'Changed outside Mik'; };
  let reads = 0; f.transfer.read = async () => structuredClone(++reads === 1 ? f.stored : f.local);
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.stored)), /changed during validation/); assert.equal(f.deletes, 0);
});

test('V2 failed recovery keeps a durable backup and does not claim success', async t => {
  const f = await replacementFixture(t);
  f.transfer.command = async args => { if (args[1] === 'delete') { f.transfer.read = async () => null; return ''; } throw new Error('native failure'); };
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.local)), /automatic recovery could not be verified/);
  assert.equal((await readdir(path.join(f.root, '.mrmak/import-backups/opencode-v2'))).length, 1);
  assert.ok((await readdir(f.root)).some(name => name.endsWith('.mik-import.lock')));
});

test('V2 unconfirmed deletion retains the original, and foreign replacement data is never deleted on rollback', async t => {
  const f = await replacementFixture(t);
  f.transfer.command = async () => { throw new Error('delete failed'); };
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.local)), /original retained/);
  assert.deepEqual(f.stored, f.local);
  const foreign = data(); foreign.messages[0].text = 'Foreign branch'; let current = f.local, deletes = 0;
  f.transfer.read = async () => structuredClone(current);
  f.transfer.command = async args => {
    if (args[1] === 'delete') { deletes++; current = null; return ''; }
    current = foreign; throw new Error('concurrent external write');
  };
  await assert.rejects(f.transfer.write(f.incoming, f.root, openCodeHash(f.local)), /automatic recovery could not be verified/);
  assert.equal(deletes, 1); assert.deepEqual(current, foreign);
});

function family() {
  const root = data(), child = data(), grandchild = data();
  child.info.id = 'ses_child'; child.info.parentID = root.info.id; child.messages[0].id = 'msg_child';
  grandchild.info.id = 'ses_grandchild'; grandchild.info.parentID = child.info.id; grandchild.messages[0].id = 'msg_grandchild';
  root.messages.push({ id: 'msg_task', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'tool', name: 'task', state: { status: 'completed', input: {}, metadata: { sessionId: child.info.id }, content: [{ type: 'text', text: 'Fixture' }] } }] });
  root.children = [grandchild, child]; return root;
}

test('V2 family validates topology, same-folder dependencies and identities; mixed branches never partially update', () => {
  const base = family(); validateV2Transfer(base);
  assert.deepEqual(v2Members(base).map(member => member.info.id), ['ses_v2fixture', 'ses_child', 'ses_grandchild']);
  for (const mutate of [
    value => { value.children[0].info.parentID = 'ses_missing'; },
    value => { value.children[0].info.location.directory = '/foreign'; },
    value => { value.children[0].messages[0].id = value.messages[0].id; },
    value => { value.messages[1].content[0].state.metadata.sessionId = 'ses_external'; },
    value => { value.children[0].children = []; },
    value => { value.children = Array.from({ length: 64 }, (_, index) => ({ ...data(), info: { ...data().info, id: `ses_extra_${index}`, parentID: value.info.id } })); },
  ]) { const invalid = structuredClone(base); mutate(invalid); assert.throws(() => validateV2Transfer(invalid)); }
  const next = structuredClone(base); next.children[0].messages.push({ id: 'msg_next_child', type: 'user', text: 'Next', time: { created: 3 } });
  assert.equal(openCodeRelation(base, next), 'update'); assert.equal(openCodeRelation(next, base), 'local-newer');
  const mixed = structuredClone(base); mixed.children[1].messages.push({ id: 'msg_local_child', type: 'user', text: 'Local', time: { created: 3 } });
  assert.equal(openCodeRelation(mixed, next), 'conflict');
});

test('V2 archive carries descendants once; deletion protects separately associated or changed children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-family-archive-')); let source, target;
  try {
    source = await hub(root, 'source'); target = await hub(root, 'target');
    const native = family(); for (const member of v2Members(native)) member.info.location.directory = source.repo;
    source.store.set(native.info.id, native);
    const id = randomUUID(); source.sessions.items.set(id, source.sessions.make({ id, agent: 'opencode', nativeId: native.info.id, cwd: source.repo, name: 'Family', hasConversation: true, open: false, createdAt: new Date().toISOString() }));
    const exported = await source.archive.exportTo(root); assert.equal((await target.archive.preview(exported.path)).native[0].familySize, 3);
    await target.archive.importFrom(exported.path); assert.equal(target.sessions.list().length, 1); validateV2Transfer(target.store.get(native.info.id));
    const deletion = new NativeDeletion(target.sessions, target.stateDir); deletion.openCode = { ...target.archive.openCode, remove: async (nativeId, hash) => { assert.equal(hash, openCodeHash(target.store.get(nativeId))); target.store.delete(nativeId); } };
    const plan = await deletion.plan(id); assert.equal(plan.nativeSessions.length, 3);
    const otherId = randomUUID(); target.sessions.items.set(otherId, target.sessions.make({ id: otherId, agent: 'opencode', nativeId: 'ses_child', cwd: target.repo, name: 'Child', open: false, hasConversation: true, createdAt: new Date().toISOString() }));
    await assert.rejects(deletion.confirm(id, plan.token, 'Family'), /references this OpenCode family/); target.sessions.items.delete(otherId);
    const changed = await deletion.plan(id); target.store.get(native.info.id).children[0].messages[0].text = 'Changed child';
    await assert.rejects(deletion.confirm(id, changed.token, 'Family'), /changed/);
    const final = await deletion.plan(id); await deletion.confirm(id, final.token, 'Family'); assert.equal(target.sessions.list().length, 0);
  } finally { await source?.sessions.close(); await target?.sessions.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
