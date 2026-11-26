import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, rm, rmdir, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';

// Transfer metadata and boundaries: unsent and unreferenced files stay local.
test('transfer preserves graphical metadata and remaps a deduplicated branch parent while unsent/unreferenced files remain excluded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-feature-transfer-audit-'));
  const previousHome = process.env.CODEX_HOME;
  const hubs = [];
  try {
    for (const name of ['source', 'target']) {
      const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
      for (const folder of ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
      await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [], resources: [] }));
      await writeFile(path.join(repo, 'projects', 'registry.json'), JSON.stringify({ projects: [] }));
      const sessions = await new Sessions(repo, stateDir).init();
      hubs.push({ repo, stateDir, sessions, archive: new PortableArchive(repo, stateDir, sessions, null) });
    }
    const [source, target] = hubs;
    const parent = randomUUID(), child = randomUUID(), localParent = randomUUID();
    const parentNative = randomUUID(), childNative = randomUUID();
    process.env.CODEX_HOME = path.join(root, 'source-codex');
    await mkdir(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
    for (const nativeId of [parentNative, childNative]) await writeFile(path.join(process.env.CODEX_HOME, 'sessions', `rollout-fixture-${nativeId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: source.repo } }) + '\n');
    const base = { agent: 'codex', cwd: source.repo, open: false, hasConversation: true, chatInterface: 'chat', graphicalModel: 'fixture-model', updatedAt: '2026-10-22T12:00:00Z' };
    source.sessions.items.set(parent, source.sessions.make({ ...base, id: parent, nativeId: parentNative, name: 'Parent' }));
    source.sessions.items.set(child, source.sessions.make({ ...base, id: child, nativeId: childNative, name: 'Child', messageOrigin: { sessionId: parent, threadId: parentNative, itemId: 'fixture-item', kind: 'branch' } }));
    await writeFile(path.join(source.stateDir, `graphical-draft-${child}.json`), JSON.stringify({ repo: source.repo, nativeId: childNative, text: 'Unsent fixture draft', attachments: [], composerContext: [], previewPaths: [] }));
    await mkdir(path.join(source.stateDir, 'chat-inputs', child), { recursive: true });
    await writeFile(path.join(source.stateDir, 'chat-inputs', child, 'Pasted-text-fixture.txt'), 'Large pasted fixture');
    await mkdir(path.join(process.env.CODEX_HOME, 'generated_images'), { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, 'generated_images', 'fixture.png'), 'Synthetic media fixture');
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    const entries = unzipSync(await readFile(exported.path));
    const saved = JSON.parse(strFromU8(entries['state/sessions.json']));
    assert.equal(saved.find(item => item.id === child).chatInterface, 'chat');
    assert.equal(saved.find(item => item.id === child).graphicalModel, 'fixture-model');
    assert.equal(Object.keys(entries).some(name => name.includes('graphical-draft-') || name.includes('Pasted-text-fixture') || name.includes('fixture.png')), false, 'Unsent drafts and unreferenced media are absent');
    process.env.CODEX_HOME = path.join(root, 'target-codex');
    target.sessions.items.set(localParent, target.sessions.make({ ...base, cwd: target.repo, id: localParent, nativeId: parentNative, name: 'Existing local parent' }));
    await target.archive.importFrom(exported.path);
    const imported = target.sessions.list();
    assert.equal(imported.some(item => item.id === parent), false, 'Parent is deduplicated by native ID');
    assert.equal(imported.find(item => item.id === child).messageOrigin.sessionId, localParent);
    assert.equal(imported.some(item => item.id === localParent), true);
    await target.archive.importFrom(exported.path);
    assert.equal(target.sessions.list().length, 2);
    assert.equal(target.sessions.get(child).messageOrigin.sessionId, localParent);
    const stored = JSON.parse(await readFile(path.join(target.stateDir, 'sessions.json'), 'utf8'));
    assert.equal(stored.find(item => item.id === child).messageOrigin.sessionId, localParent);
  } finally {
    await Promise.all(hubs.map(hub => hub.sessions.close()));
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});

test('transfer audit preserves Hub scopes and blocks destination type/link conflicts before writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-transfer-boundary-audit-'));
  const hubs = [];
  let junction;
  try {
    for (const name of ['source', 'failed-target', 'linked-target']) {
      const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
      for (const folder of ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
      await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [], resources: [] }));
      await writeFile(path.join(repo, 'projects', 'registry.json'), JSON.stringify({ projects: [] }));
      const sessions = await new Sessions(repo, stateDir).init();
      hubs.push({ repo, stateDir, sessions, archive: new PortableArchive(repo, stateDir, sessions, null) });
    }
    const [source, failed, linked] = hubs;
    const kimiId = randomUUID();
    source.sessions.items.set(kimiId, source.sessions.make({ id: kimiId, agent: 'kimi', cwd: source.repo, open: false, nativeId: randomUUID(), hasConversation: true, name: 'Kimi history fixture', accountProfileLabel: 'private@example.invalid' }));
    await writeFile(path.join(source.repo, 'AGENTS.md'), 'Custom Hub fixture instructions');
    await writeFile(path.join(source.repo, 'CLAUDE.md'), 'Custom Claude fixture instructions');
    const scope = { skills: { fixture: { global: false, projects: {} } } };
    await writeFile(path.join(source.repo, 'projects', 'skill-scopes.json'), JSON.stringify(scope));
    await writeFile(path.join(source.repo, 'knowledge', 'first.md'), 'Earlier content fixture');
    await writeFile(path.join(source.repo, 'processes', 'later.md'), 'Later content fixture');
    await mkdir(path.join(source.repo, 'inbox', 'attachments'), { recursive: true });
    await writeFile(path.join(source.repo, 'inbox', 'attachments', 'fixture.png'), 'Synthetic attachment bytes');
    const outsideSource = path.join(root, 'isolated-source-target');
    await mkdir(outsideSource);
    await writeFile(path.join(outsideSource, 'sentinel.md'), '# Outside the Hub');
    const context = path.join(source.repo, 'context');
    await rmdir(context);
    junction = context;
    await symlink(outsideSource, context, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(source.archive.exportTo(root, { chats: 'full' }), /unsafe link/);
    assert.equal(await readFile(path.join(outsideSource, 'sentinel.md'), 'utf8'), '# Outside the Hub');
    await rm(context); junction = null;
    await mkdir(context);
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    const entries = unzipSync(await readFile(exported.path));
    assert.deepEqual(JSON.parse(strFromU8(entries['projects/skill-scopes.json'])), scope);
    assert.equal(strFromU8(entries['inbox/attachments/fixture.png']), 'Synthetic attachment bytes');
    assert.equal(entries['AGENTS.md'], undefined, 'Custom root instructions currently excluded');
    assert.equal(entries['CLAUDE.md'], undefined);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.equal(manifest.native.length, 0, 'Kimi has no native transfer adapter');
    assert.equal(manifest.nativeOmissions.length, 0, 'Unsupported-agent notices remain separate from unavailable supported-native exclusions');
    assert.match(exported.coverage.find(item => item.agent === 'kimi').reason, /not supported/);
    assert.doesNotMatch(JSON.stringify(exported.coverage), /private@example.invalid/);
    const light = await source.archive.exportTo(root, { chats: 'light' });
    assert.match(light.coverage.find(item => item.agent === 'kimi').reason, /light export|not supported/);
    const review = await source.archive.reviewExport(root);
    assert.match(review.notices.find(item => item.agent === 'kimi').reason, /not supported/);

    // Simulate a destination type conflict, entirely inside this fixture.
    await rm(path.join(failed.repo, 'processes'), { recursive: true });
    await writeFile(path.join(failed.repo, 'processes'), 'Blocking fixture file');
    await assert.rejects(failed.archive.importFrom(exported.path), /not a directory/);
    assert.equal(await lstat(path.join(failed.repo, 'knowledge', 'first.md')).catch(() => null), null);

    const outside = path.join(root, 'isolated-junction-target');
    await mkdir(outside);
    junction = path.join(linked.repo, 'processes');
    await rm(junction, { recursive: true });
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(linked.archive.importFrom(exported.path), /unsafe link/);
    assert.equal(await lstat(path.join(outside, 'later.md')).catch(() => null), null);
    assert.equal(await lstat(path.join(linked.repo, 'knowledge', 'first.md')).catch(() => null), null);
    await rm(junction); junction = null;
    await mkdir(path.join(linked.repo, 'processes'));
    await linked.archive.importFrom(exported.path);
    assert.match(linked.sessions.list().find(item => item.id === kimiId).nativeUnavailable, /Kimi native conversations are not included/);
  } finally {
    if (junction && (await lstat(junction).catch(() => null))?.isSymbolicLink()) await rm(junction);
    await Promise.all(hubs.map(hub => hub.sessions.close()));
  }
});
