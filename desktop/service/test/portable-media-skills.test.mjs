import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, readdir, lstat, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { referencedMedia, resolveConversationMedia, validateMediaManifest, mergeMediaIndexes } from '../conversation-media.mjs';
import { ImportTransaction } from '../import-transaction.mjs';
import { claudeTranscript } from '../native-events.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-media-skills-')), hubs = [];
  const make = async name => {
    const repo = path.join(root, name), state = path.join(repo, '.mrmak');
    for (const folder of ['.mrmak', 'workspace', 'projects', 'inbox/attachments']) await mkdir(path.join(repo, folder), { recursive: true });
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
    await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
    const sessions = await new Sessions(repo, state).init();
    const hub = { repo, state, sessions, archive: new PortableArchive(repo, state, sessions, null) }; hubs.push(hub); return hub;
  };
  const source = await make('source');
  const nativeId = randomUUID(), sessionId = randomUUID(), home = path.join(root, 'source-codex');
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const external = path.join(root, 'external.png'), duplicate = path.join(root, 'duplicate.png'), missing = path.join(root, 'missing.png');
  const hubImage = path.join(source.repo, 'inbox/attachments/hub.png');
  await writeFile(external, 'Synthetic external image'); await writeFile(duplicate, 'Synthetic external image'); await writeFile(hubImage, 'Synthetic Hub image');
  const transcript = path.join(home, 'sessions', `rollout-fixture-${nativeId}.jsonl`);
  const rows = [
    { type: 'session_meta', payload: { id: nativeId, cwd: source.repo } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Attached paths:\n${JSON.stringify(hubImage)}` }] } },
    { type: 'response_item', payload: { type: 'image_generation_call', result: external } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `![Duplicate](<${duplicate}>)\n![Missing](<${missing}>)` }] } },
  ];
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  source.sessions.items.set(sessionId, source.sessions.make({ id: sessionId, agent: 'codex', nativeId, cwd: source.repo, chatInterface: 'chat', open: false, hasConversation: true }));
  return { root, source, make, home, nativeId, sessionId, external, duplicate, hubImage, transcript, close: async () => { await Promise.all(hubs.map(hub => hub.sessions.close())); } };
}

test('export keeps Hub media and native bytes, and includes deduplicated external media only after approval', async () => {
  const previous = process.env.CODEX_HOME, f = await fixture();
  try {
    process.env.CODEX_HOME = f.home;
    const originalMedia = await readFile(f.external);
    const staleReview = await f.source.archive.reviewExport(f.root);
    await writeFile(f.external, 'Changed after review');
    await writeFile(f.external, 'Changed after review');
    await assert.rejects(f.source.archive.exportTo(f.root, { attachmentToken: staleReview.token, includeMedia: true, approveMedia: true }), /changed after review/);
    assert.equal((await readdir(f.root)).some(name => name.endsWith('.mrmak.zip')), false);
    assert.deepEqual(referencedMedia({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ path: f.external }) } }), []);
    const spaced = path.join(f.root, 'cat portrait.png');
    assert.deepEqual(referencedMedia({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `![Cat](<${spaced.replaceAll(' ', '%20')}#preview>)` }] } }), [spaced]);
    assert.throws(() => validateMediaManifest({ version: 1, refs: [{ agent: 'codex', threadId: f.nativeId, source: f.external, target: '../escape.png' }] }), /Invalid conversation media/);
    await writeFile(f.external, originalMedia);
    const review = await f.source.archive.reviewExport(f.root);
    assert.equal(review.media.files.length, 2); assert.equal(review.media.hubFiles, 1); assert.equal(review.media.omissions.length, 1);
    const exported = await f.source.archive.exportTo(f.root, { attachmentToken: review.token });
    const entries = unzipSync(await readFile(exported.path)), manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.equal(manifest.version, 2); assert.equal(manifest.media.refs.length, 1); assert.equal(manifest.media.omissions.length, 3);
    assert.equal(strFromU8(entries['inbox/attachments/hub.png']), 'Synthetic Hub image');
    assert.equal(Object.keys(entries).filter(name => name.startsWith('inbox/attachments/conversation-media/')).length, 0);
    assert.equal(strFromU8(entries[`native/codex/${f.nativeId}.jsonl`]), await readFile(f.transcript, 'utf8'));
    const target = await f.make('without-media'); process.env.CODEX_HOME = path.join(f.root, 'target-codex-none');
    await target.archive.importFrom(exported.path);
    assert.equal(await resolveConversationMedia(target.repo, target.state, 'codex', f.nativeId, f.hubImage), path.join(target.repo, 'inbox/attachments/hub.png'));
    assert.equal(await resolveConversationMedia(target.repo, target.state, 'codex', randomUUID(), f.hubImage), null);

    process.env.CODEX_HOME = f.home;
    const includedReview = await f.source.archive.reviewExport(f.root);
    const includedExport = await f.source.archive.exportTo(f.root, { attachmentToken: includedReview.token, includeMedia: true, approveMedia: true });
    const includedEntries = unzipSync(await readFile(includedExport.path)), includedManifest = JSON.parse(strFromU8(includedEntries['manifest.json']));
    assert.equal(includedManifest.media.refs.length, 3);
    assert.equal(Object.keys(includedEntries).filter(name => name.startsWith('inbox/attachments/conversation-media/')).length, 1);
    await rm(f.external); await rm(f.duplicate);
    const includedTarget = await f.make('with-media'); process.env.CODEX_HOME = path.join(f.root, 'target-codex-yes');
    await includedTarget.archive.importFrom(includedExport.path); await includedTarget.archive.importFrom(includedExport.path);
    const actual = await resolveConversationMedia(includedTarget.repo, includedTarget.state, 'codex', f.nativeId, f.external);
    assert.equal(await readFile(actual, 'utf8'), 'Synthetic external image');
    assert.equal(await resolveConversationMedia(includedTarget.repo, includedTarget.state, 'codex', f.nativeId, f.duplicate), actual);
    const again = await includedTarget.archive.exportTo(f.root);
    const repeated = JSON.parse(strFromU8(unzipSync(await readFile(again.path))['manifest.json']));
    assert.equal(repeated.media.refs.length, 3);
    assert.equal(includedTarget.sessions.list().length, 1);
    const localNative = path.join(process.env.CODEX_HOME, 'sessions', `rollout-fixture-${f.nativeId}.jsonl`);
    await appendFile(localNative, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Local continuation fixture' } }) + '\n');
    await rm(path.join(includedTarget.state, 'conversation-media.json'));
    await includedTarget.archive.importFrom(includedExport.path);
    assert.match(await readFile(localNative, 'utf8'), /Local continuation fixture/);
    assert.equal(await resolveConversationMedia(includedTarget.repo, includedTarget.state, 'codex', f.nativeId, f.external), actual);
  } finally { await f.close(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('full import merges effective default/stored skill scopes without replacing destination-only projects', async () => {
  const f = await fixture();
  try {
    const a = randomUUID(), b = randomUUID();
    await writeFile(path.join(f.source.repo, 'projects/skill-scopes.json'), JSON.stringify({ skills: { same: { global: false, projects: { [a]: false, [b]: true } }, added: { global: true, projects: {} } } }));
    const exported = await f.source.archive.exportTo(f.root, { chats: 'light' });
    for (const select of [false, true]) {
      const target = await f.make(`skills-${select}`);
      await writeFile(path.join(target.repo, 'projects/skill-defaults.json'), JSON.stringify({ skills: { same: { global: true, projects: { [a]: true } }, local: { global: false, projects: {} } } }));
      const preview = await target.archive.preview(exported.path);
      assert.equal(preview.skillConflicts.length, 2);
      assert.equal(preview.hubConflicts.some(item => item.name === 'projects/skill-scopes.json'), false);
      const chosen = select ? [preview.skillConflicts.find(item => item.scope === 'project').id] : [];
      if (select) {
        const overrides = path.join(target.repo, 'projects/skill-scopes.json');
        const changed = JSON.stringify({ skills: { same: { projects: { [a]: false } } } });
        await writeFile(overrides, changed);
        await assert.rejects(target.archive.importFrom(exported.path, { replaceSkills: chosen }), /choices changed/);
        assert.equal(await readFile(overrides, 'utf8'), changed);
        assert.equal(await lstat(path.join(target.repo, 'inbox/attachments/hub.png')).catch(() => null), null);
        assert.equal(target.sessions.persistenceHolds, 0);
        await unlink(overrides);
      }
      await target.archive.importFrom(exported.path, { replaceSkills: chosen });
      const result = JSON.parse(await readFile(path.join(target.repo, 'projects/skill-scopes.json')));
      assert.equal(result.skills.same.global, true); assert.equal(result.skills.same.projects[a], !select); assert.equal(result.skills.same.projects[b], true);
      assert.equal(result.skills.local.global, false); assert.equal(result.skills.added.global, true);
      await target.archive.importFrom(exported.path);
      assert.equal(JSON.parse(await readFile(path.join(target.repo, 'projects/skill-scopes.json'))).skills.same.projects[a], !select);
    }
  } finally { await f.close(); }
});

test('media bindings/files and skill merges roll back together on a late import failure', async () => {
  const previous = process.env.CODEX_HOME, f = await fixture(), commit = ImportTransaction.prototype.commit;
  try {
    process.env.CODEX_HOME = f.home;
    await writeFile(path.join(f.source.repo, 'projects/skill-scopes.json'), '{"skills":{"incoming":{"global":true}}}');
    const review = await f.source.archive.reviewExport(f.root);
    const exported = await f.source.archive.exportTo(f.root, { attachmentToken: review.token, includeMedia: true, approveMedia: true });
    const target = await f.make('rollback'); process.env.CODEX_HOME = path.join(f.root, 'rollback-codex');
    const scopeFile = path.join(target.repo, 'projects/skill-scopes.json');
    await writeFile(scopeFile, '{"skills":{"local":{"global":false}}}');
    ImportTransaction.prototype.commit = async function () { if (this.repo === target.repo) throw new Error('Injected post-media failure'); return commit.call(this); };
    await assert.rejects(target.archive.importFrom(exported.path), /Injected post-media failure/);
    assert.equal(await readFile(scopeFile, 'utf8'), '{"skills":{"local":{"global":false}}}');
    assert.equal(await lstat(path.join(target.state, 'conversation-media.json')).catch(() => null), null);
    assert.equal(await lstat(path.join(target.repo, 'inbox/attachments/conversation-media')).catch(() => null), null);
    assert.equal(target.sessions.list().length, 0);
    assert.equal(target.sessions.persistenceHolds, 0);
  } finally { ImportTransaction.prototype.commit = commit; await f.close(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('Claude typed image sources transfer through the same reviewed media inventory', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR, f = await fixture();
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(f.root, 'claude-source');
    const session = f.source.sessions.get(f.sessionId); session.agent = 'claude'; session.chatInterface = 'cli';
    const transcript = await claudeTranscript(f.source.repo, f.nativeId);
    await mkdir(path.dirname(transcript), { recursive: true });
    const raw = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'file', path: f.external } }] } }) + '\n';
    await writeFile(transcript, raw);
    const review = await f.source.archive.reviewExport(f.root);
    assert.equal(review.media.files.length, 1);
    const exported = await f.source.archive.exportTo(f.root, { attachmentToken: review.token, includeMedia: true, approveMedia: true });
    const target = await f.make('claude-target'); process.env.CLAUDE_CONFIG_DIR = path.join(f.root, 'claude-destination');
    await rm(f.external); await target.archive.importFrom(exported.path);
    assert.equal(await readFile(await resolveConversationMedia(target.repo, target.state, 'claude', f.nativeId, f.external), 'utf8'), 'Synthetic external image');
  } finally { await f.close(); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});

test('media file conflicts obey Hub replacement choices and reexport the chosen local content', async () => {
  const previous = process.env.CODEX_HOME, f = await fixture();
  try {
    process.env.CODEX_HOME = f.home;
    const registry = 'workspace/workspace.json', incomingWorkspace = randomUUID();
    await writeFile(path.join(f.source.repo, registry), JSON.stringify({ entities: [{ id: 'shared', title: 'Imported card', pinned: true }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', projectId: incomingWorkspace }] }));
    const exported = await f.source.archive.exportTo(f.root);
    const target = await f.make('hub-media-conflict');
    process.env.CODEX_HOME = path.join(f.root, 'conflict-codex');
    await writeFile(path.join(target.repo, registry), JSON.stringify({ entities: [{ id: 'shared', title: 'Local card', pinned: false }, { id: 'local', title: 'Keep me' }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', projectId: null }] }));
    const file = path.join(target.repo, 'inbox/attachments/hub.png');
    await writeFile(file, 'Destination image retained by default');
    await target.archive.importFrom(exported.path);
    assert.equal(await readFile(await resolveConversationMedia(target.repo, target.state, 'codex', f.nativeId, f.hubImage), 'utf8'), 'Destination image retained by default');
    const cards = () => readFile(path.join(target.repo, registry), 'utf8').then(JSON.parse);
    assert.equal((await cards()).entities.find(item => item.id === 'shared').title, 'Local card');
    assert.equal((await cards()).resources[0].projectId, null);
    const again = await target.archive.exportTo(f.root);
    const entries = unzipSync(await readFile(again.path));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.equal(strFromU8(entries['inbox/attachments/hub.png']), 'Destination image retained by default');
    validateMediaManifest(manifest.media, manifest);
    await target.archive.importFrom(exported.path, { replaceHub: ['inbox/attachments/hub.png'] });
    assert.equal(await readFile(file, 'utf8'), 'Synthetic Hub image');
    assert.equal((await cards()).entities.find(item => item.id === 'shared').title, 'Local card');
    await target.archive.importFrom(exported.path, { replaceHub: [registry] });
    const importedCards = await cards();
    assert.equal(importedCards.entities.find(item => item.id === 'shared').pinned, true);
    assert.equal(importedCards.entities.find(item => item.id === 'local').title, 'Keep me');
    assert.equal(importedCards.resources[0].projectId, incomingWorkspace);
  } finally { await f.close(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('media bindings preserve newer local choices and reject invalid native/file associations', () => {
  const threadId = randomUUID(), key = `codex:${threadId}`;
  const ref = { agent: 'codex', threadId, source: 'C:/fixture/image.png', target: 'inbox/image.png', sha256: 'a'.repeat(64), bytes: 3 };
  const incoming = { ...ref, sha256: 'b'.repeat(64) };
  assert.deepEqual(mergeMediaIndexes({ refs: [ref] }, { refs: [incoming] }, new Set([key])).refs, [ref]);
  assert.deepEqual(mergeMediaIndexes({ refs: [ref] }, { refs: [incoming] }, new Set([key]), new Set([key])).refs, [incoming]);
  assert.deepEqual(mergeMediaIndexes({ refs: [] }, { refs: [incoming] }, new Set()).refs, []);
  const media = { version: 1, refs: [ref] };
  assert.throws(() => validateMediaManifest(media, { native: [], files: [{ name: ref.target, sha256: ref.sha256, size: 3 }] }), /not associated/);
  assert.throws(() => validateMediaManifest(media, { native: [{ agent: 'codex', id: threadId }], files: [{ name: ref.target, sha256: ref.sha256, size: 4 }] }), /not associated/);
});
