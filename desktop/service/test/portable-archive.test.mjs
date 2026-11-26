import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { claudeTranscript, codexTranscript } from '../native-events.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Projects } from '../projects.mjs';
import { leaseConversation } from '../conversation-lease.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';

test('native import rejects another managed writer before changing Hub files and releases only its own leases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-import-lease-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target'), previous = process.env.CODEX_HOME;
  let release;
  try {
    const sourceHome = path.join(root, 'source-codex'), targetHome = path.join(root, 'target-codex');
    process.env.CODEX_HOME = sourceHome;
    await mkdir(path.join(sourceHome, 'sessions'), { recursive: true });
    await writeFile(path.join(sourceHome, 'sessions', `rollout-fixture-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: source.repo } }) + '\n');
    await writeFile(path.join(source.repo, 'knowledge', 'incoming.md'), '# Incoming fixture');
    source.sessions.items.set(projectId, source.sessions.make({ id: projectId, agent: 'codex', nativeId: id, cwd: source.repo, name: 'Lease fixture', open: false, hasConversation: true }));
    const archive = await source.archive.exportTo(root, { chats: 'full' });
    process.env.CODEX_HOME = targetHome;
    const context = { sqliteHome: targetHome }; target.sessions.accountContext = async () => context;
    release = await leaseConversation(context, id);
    await assert.rejects(target.archive.importFrom(archive.path), /already owned/);
    assert.equal(await stat(path.join(target.repo, 'knowledge', 'incoming.md')).catch(() => null), null);
    assert.equal(target.sessions.list().length, 0);
    await release(); release = null;
    assert.equal((await target.archive.importFrom(archive.path)).nativeImported, 1);
  } finally {
    await release?.(); await source.sessions.close(); await target.sessions.close();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('portable profile references exclude local account labels/store identities and require explicit destination mapping', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mr-mik-profile-transfer-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const profileId = '33333333-3333-4333-8333-333333333333';
  try {
    source.sessions.items.set(id, source.sessions.make({ id, agent: 'codex', accountProfileId: profileId, accountProfileLabel: 'private-account@example.invalid', conversationStoreId: 'a'.repeat(64), name: 'Profile transfer', cwd: source.repo, open: false, nativeId: null, hasConversation: false }));
    await writeFile(path.join(source.stateDir, 'mak-conversations.json'), JSON.stringify({ conversations: [{ id: 'mik-fixture', projectId: null, threadId: null, parentId: null, title: 'Profile conversation', at: '2026-10-15T10:00:00Z', accountProfileId: profileId, conversationStoreId: 'a'.repeat(64) }], selected: { global: 'mik-fixture' } }));
    const archive = await source.archive.exportTo(root, { chats: 'light' });
    const entries = unzipSync(await readFile(archive.path));
    const chats = JSON.parse(strFromU8(entries['state/sessions.json']));
    assert.equal(chats[0].accountProfileId, profileId);
    assert.equal(chats[0].accountProfileLabel, undefined); assert.equal(chats[0].conversationStoreId, undefined);
    const mak = JSON.parse(strFromU8(entries['state/mak-conversations.json']));
    assert.equal(mak.conversations[0].conversationStoreId, undefined);
    await target.archive.importFrom(archive.path);
    const incoming = target.sessions.get(id);
    assert.equal(incoming.accountProfileId, 'unmapped-' + profileId);
    assert.equal(incoming.conversationStoreId, null);
    const importedMak = JSON.parse(await readFile(path.join(target.stateDir, 'mak-conversations.json'), 'utf8'));
    assert.equal(importedMak.conversations[0].accountProfileId, 'unmapped-' + profileId);
  } finally { await source.sessions.close(); await target.sessions.close(); }
});

test('mixed partial full transfer keeps healthy native contexts and protects local chats', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-partial-transfer-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const oldCodex = process.env.CODEX_HOME, oldClaude = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CODEX_HOME = path.join(root, 'pc1-codex'); process.env.CLAUDE_CONFIG_DIR = path.join(root, 'pc1-claude');
    const fixtureChats = [];
    for (const agent of ['codex', 'claude']) {
      const nativeId = randomUUID();
      const healthy = { id: randomUUID(), agent, ...(agent === 'codex' ? { codexPermissions: 'full-access' } : {}), nativeId, name: 'Healthy context', cwd: source.repo, hasConversation: true, open: false, updatedAt: '2026-10-02T00:00:00Z' };
      const missing = { ...healthy, id: randomUUID(), nativeId: randomUUID(), name: 'Missing context' };
      fixtureChats.push({ agent, healthy, missing });
      for (const chat of [healthy, missing]) source.sessions.items.set(chat.id, source.sessions.make(chat));
      const file = agent === 'codex' ? path.join(process.env.CODEX_HOME, 'sessions', 'rollout-fixture-' + nativeId + '.jsonl') : await claudeTranscript(source.repo, nativeId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: source.repo } }) + '\n');
    }
    const unavailableKeys = fixtureChats.map(({ agent, missing }) => `${agent}:${missing.nativeId}`).sort();
    const healthyKeys = fixtureChats.map(({ agent, healthy }) => `${agent}:${healthy.nativeId}`).sort();
    const missingId = randomUUID();
    const dormantId = randomUUID();
    const dormant = source.sessions.make({ id: dormantId, name: 'Unused Claude tab', agent: 'claude', nativeId: randomUUID(), cwd: source.repo, hasConversation: false, open: false });
    source.sessions.items.set(dormantId, dormant);
    const dormantReview = await source.archive.reviewExport(root);
    assert.equal(dormantReview.issues.some(issue => issue.sessionId === dormantId), false);
    dormant.lastInputAt = '2026-09-30T00:01:00Z';
    assert.match((await source.archive.reviewExport(root)).issues.find(issue => issue.sessionId === dormantId).reason, /transcript/i);
    source.sessions.items.delete(dormantId);
    source.sessions.items.set(missingId, source.sessions.make({ id: missingId, name: 'Missing native ID', agent: 'codex', cwd: source.repo, nativeId: null, hasConversation: true, open: false }));
    const incomplete = await source.archive.reviewExport(root);
    assert.equal(incomplete.issues.length, 3);
    assert.match(incomplete.issues.find(issue => issue.sessionId === missingId).reason, /native ID missing/i);
    await assert.rejects(source.archive.exportTo(root), /3 native chat.*light export/is);
    const light = await source.archive.exportTo(root, { chats: 'light' });
    assert.ok((await stat(light.path)).isFile());
    assert.match(path.basename(light.path), /^MrMik-Workspace-.*\.mrmak\.zip$/);
    source.sessions.items.delete(missingId);
    let review = await source.archive.reviewExport(root); assert.deepEqual(review.issues.map(item => item.key).sort(), unavailableKeys);
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token }), /explicitly confirm/);
    review = await source.archive.reviewExport(root);
    await assert.rejects(source.archive.exportTo(root, { attachmentToken: review.token, skipNative: healthyKeys }), /Healthy chats/);
    review = await source.archive.reviewExport(root);
    const archive = await source.archive.exportTo(root, { attachmentToken: review.token, skipNative: review.issues.map(item => item.key) });
    assert.equal(archive.chats, 2); assert.equal(archive.omitted, 2);
    for (const { agent } of fixtureChats) {
      const row = archive.coverage.find(item => item.agent === agent);
      assert.equal(row.historyEntries, 2);
      assert.equal(row.nativeConversations, 1);
    }
    for (const { missing } of fixtureChats) assert.equal(source.sessions.get(missing.id).nativeUnavailable, undefined);
    process.env.CODEX_HOME = path.join(root, 'pc2-codex'); process.env.CLAUDE_CONFIG_DIR = path.join(root, 'pc2-claude');
    const plan = await target.archive.preview(archive.path), unavailable = plan.native.filter(item => item.status === 'unavailable');
    assert.deepEqual(plan.native.filter(item => item.status === 'new').map(item => item.agent + ':' + item.id).sort(), healthyKeys);
    assert.deepEqual(unavailable.map(item => item.key).sort(), unavailableKeys);
    await assert.rejects(target.archive.importFrom(archive.path), /explicitly confirm/); assert.equal(target.sessions.list().length, 0);
    const options = { skipNative: unavailable.map(item => item.key), reviewHash: plan.reviewHash };
    await assert.rejects(target.archive.importFrom(archive.path, { ...options, reviewHash: 'stale' }), /archive changed/);
    const result = await target.archive.importFrom(archive.path, options);
    assert.equal(result.nativeImported, 2); assert.equal(result.nativeUnavailable, 2);
    for (const { agent, healthy, missing } of fixtureChats) {
      assert.ok(target.sessions.get(missing.id).nativeUnavailable);
      assert.equal(target.sessions.get(healthy.id).nativeUnavailable, null);
      if (agent === 'codex') assert.equal(target.sessions.get(healthy.id).codexPermissions, 'full-access');
      await assert.rejects(target.sessions.resume(missing.id), /native conversation could not be located/);
      target.sessions.get(missing.id).nativeUnavailable = null;
      target.sessions.get(missing.id).preview = 'Local healthy state';
    }
    await target.archive.importFrom(archive.path, options);
    for (const { missing } of fixtureChats) {
      assert.equal(target.sessions.get(missing.id).preview, 'Local healthy state');
      assert.equal(target.sessions.get(missing.id).nativeUnavailable, null);
    }
    // An old archive whose manifest declares a missing transcript can be safely
    // isolated too; corruption of present bytes remains an archive-wide failure.
    const entries = unzipSync(await readFile(archive.path)), manifest = JSON.parse(strFromU8(entries['manifest.json']));
    const native = manifest.native[0]; delete entries[native.name];
    const partialPath = path.join(root, 'missing-entry.mrmak.zip'); await writeFile(partialPath, zipSync(entries));
    const partial = await target.archive.preview(partialPath); assert.equal(partial.native.filter(item => item.status === 'unavailable').length, 3);
    const partialResult = await target.archive.importFrom(partialPath, { skipNative: partial.native.filter(item => item.status === 'unavailable').map(item => item.key), reviewHash: partial.reviewHash }); assert.equal(partialResult.nativeImported, 0);
    entries[native.name] = strToU8('invalid JSONL\n'); const tamperedPath = path.join(root, 'tampered.mrmak.zip'); await writeFile(tamperedPath, zipSync(entries));
    await assert.rejects(target.archive.preview(tamperedPath), /integrity/);
    const declaration = manifest.files.find(item => item.name === native.name); declaration.size = entries[native.name].length; declaration.sha256 = createHash('sha256').update(entries[native.name]).digest('hex'); native.sha256 = declaration.sha256;
    entries['manifest.json'] = strToU8(JSON.stringify(manifest)); const invalidPath = path.join(root, 'invalid-chat.mrmak.zip'); await writeFile(invalidPath, zipSync(entries));
    assert.equal((await target.archive.preview(invalidPath)).native.filter(item => item.status === 'unavailable').length, 3);
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  }
});

test('Mak full export transfers native coordinator context and branches; light is History-only; reimport deduplicates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-mak-native-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(root, 'pc1');
    const file = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30', `rollout-fixture-${id}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });

    const conversation = { id: projectId, threadId: id, projectId: null, title: 'Fixture Mak', parentId: null, at: '2026-09-30T00:00:00Z', effort: 'low', model: 'fixture-model', updatedAt: '2026-09-30T00:01:00Z' };
    await writeFile(path.join(source.stateDir, 'mak-conversations.json'), JSON.stringify({ conversations: [conversation], selected: { global: projectId } }));
    await writeFile(path.join(source.stateDir, 'settings.json'), JSON.stringify({ defaultWorkerEffort: 'ultra', defaultClaudeWorkerEffort: 'max', coordinatorEffort: 'low', defaultCodexPermissions: 'full-access', defaultClaudePermissions: 'ask' }));
    await assert.rejects(source.archive.exportTo(root), /Fixture Mak/);
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: source.repo } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fixture context' }] } }) + '\n');
    const light = await source.archive.exportTo(root, { chats: 'light' });
    const full = await source.archive.exportTo(root, { chats: 'full' });
    process.env.CODEX_HOME = path.join(root, 'pc2');
    assert.equal((await target.archive.preview(light.path)).native.length, 0);
    const plan = await target.archive.preview(full.path); assert.equal(plan.native.length, 1); assert.ok(plan.native[0].name.startsWith('Mak'));
    await target.archive.importFrom(full.path, { restoreSettings: true }); await target.archive.importFrom(full.path);
    const importedSettings = JSON.parse(await readFile(path.join(target.stateDir, 'settings.json'), 'utf8'));
    assert.equal(importedSettings.defaultCodexPermissions, 'full-access'); assert.equal(importedSettings.defaultClaudePermissions, 'ask'); assert.equal(importedSettings.defaultWorkerEffort, 'ultra'); assert.equal(importedSettings.defaultClaudeWorkerEffort, 'max'); assert.equal(importedSettings.coordinatorEffort, 'low');
    const records = JSON.parse(await readFile(path.join(target.stateDir, 'mak-conversations.json'), 'utf8'));
    assert.equal(records.conversations.length, 1); assert.equal(records.selected.global, projectId);
    assert.equal(records.conversations[0].effort, 'low'); assert.equal(records.conversations[0].model, 'fixture-model');
    assert.ok((await readFile(await codexTranscript(id), 'utf8')).includes('Fixture context'));
    assert.equal(target.sessions.list().length, 0);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

for (const agent of ['codex', 'claude']) test(`${agent}: two-computer import updates continuations, History/screens and backs up divergence without duplicates`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), `mrmak-${agent}-incremental-`));
  const variable = agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  const previous = process.env[variable];
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  const useHome = name => { process.env[variable] = path.join(root, name); };
  try {
    useHome('pc1');
    const chat = { id, agent, nativeId: id, name: 'Original', cwd: source.repo, open: false, status: 'stopped', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', hasConversation: true };
    source.sessions.items.set(id, source.sessions.make(chat));
    const file = agent === 'codex' ? path.join(process.env[variable], 'sessions', '2026', '01', '01', `rollout-${id}.jsonl`) : await claudeTranscript(source.repo, id);
    await mkdir(path.dirname(file), { recursive: true });
    const first = JSON.stringify(agent === 'codex' ? { type: 'session_meta', payload: { id, cwd: source.repo } } : { type: 'user', uuid: id, message: { content: 'A' } }) + '\n';
    const continuation = first + '{"type":"assistant","message":{"content":"B"}}\n';
    await writeFile(file, first);
    await writeFile(path.join(source.stateDir, `screen-${id}.json`), JSON.stringify({ data: 'OLD SCREEN' }));
    const old = await source.archive.exportTo(root);
    await writeFile(file, continuation);
    Object.assign(source.sessions.get(id), { name: 'Continued', updatedAt: '2026-01-02T00:00:00Z', pinned: true, archived: true });
    await writeFile(path.join(source.stateDir, `screen-${id}.json`), JSON.stringify({ data: 'NEW SCREEN' }));
    if (agent === 'claude') {
      await mkdir(path.join(path.dirname(file), id, 'subagents'), { recursive: true });
      await writeFile(path.join(path.dirname(file), id, 'subagents', 'worker.jsonl'), '{"type":"assistant"}\n');
    }
    const newer = await source.archive.exportTo(root);
    useHome('pc2');
    await target.archive.importFrom(old.path);
    assert.equal(target.sessions.list().length, 1);
    // Different Mr. Mik IDs may refer to the same native conversation.
    const localId = '33333333-3333-4333-8333-333333333333';
    const original = target.sessions.get(id);
    original.id = localId;
    target.sessions.items.delete(id); target.sessions.items.set(localId, original);
    await writeFile(path.join(target.stateDir, `screen-${localId}.json`), JSON.stringify({ data: 'OLD SCREEN' }));
    const local = agent === 'codex' ? await codexTranscript(id) : await claudeTranscript(target.repo, id);
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'update');
    const result = await target.archive.importFrom(newer.path);
    assert.equal(result.nativeUpdated, 1); assert.equal(result.sessionsUpdated, 1);
    assert.equal(target.sessions.list().length, 1);
    assert.equal(target.sessions.list()[0].id, localId);
    assert.equal(target.sessions.list()[0].name, 'Continued');
    assert.equal(target.sessions.list()[0].pinned, true);
    assert.equal(target.sessions.list()[0].archived, true);
    assert.equal(target.sessions.list()[0].cwd, target.repo);
    assert.match(await readFile(path.join(target.stateDir, `screen-${localId}.json`), 'utf8'), /NEW SCREEN/);
    assert.equal(await readFile(local, 'utf8'), continuation);
    assert.equal(await readFile(path.join(result.backup, 'native', agent, `${id}.jsonl`), 'utf8'), first);
    assert.ok(JSON.parse(await readFile(path.join(result.backup, 'state', 'sessions.json'), 'utf8')).some(item => item.id === localId));
    if (agent === 'claude') assert.equal(await readFile(path.join(path.dirname(local), id, 'subagents', 'worker.jsonl'), 'utf8'), '{"type":"assistant"}\n');
    assert.equal((await target.archive.importFrom(newer.path)).nativeUpdated, 0);
    assert.equal((await target.archive.preview(old.path)).native[0].status, 'local-newer');
    await target.archive.importFrom(old.path);
    assert.equal(target.sessions.get(localId).name, 'Continued');
    assert.equal(await readFile(local, 'utf8'), continuation);
    const divergent = first + '{"type":"assistant","message":{"content":"LOCAL BRANCH"}}\n';
    await writeFile(local, divergent);
    target.sessions.get(localId).name = 'Local branch name';
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'conflict');
    await target.archive.importFrom(newer.path);
    assert.equal(await readFile(local, 'utf8'), divergent);
    assert.equal(target.sessions.get(localId).name, 'Local branch name');
    const replaced = await target.archive.importFrom(newer.path, { replaceNative: [`${agent}:${id}`] });
    assert.equal(await readFile(local, 'utf8'), continuation);
    assert.equal(target.sessions.get(localId).name, 'Continued');
    assert.equal(await readFile(path.join(replaced.backup, 'native', agent, `${id}.jsonl`), 'utf8'), divergent);
    await writeFile(local, first.slice(0, -1));
    assert.equal((await target.archive.preview(newer.path)).native[0].status, 'conflict', 'an incomplete final record is not ancestry');
    await writeFile(local, first);
    const duplicate = agent === 'codex' ? path.join(process.env[variable], 'sessions', 'duplicate', `rollout-${id}.jsonl`) : path.join(process.env[variable], 'projects', 'duplicate', `${id}.jsonl`);
    await mkdir(path.dirname(duplicate), { recursive: true }); await writeFile(duplicate, first);
    const ambiguous = await target.archive.preview(newer.path); assert.equal(ambiguous.native[0].status, 'unavailable');
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
});

async function hub(root, name) {
  const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
  for (const folder of ['context', 'knowledge', 'processes', 'inbox', 'workspace', 'projects', '.mrmak']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [], resources: [] }));
  await writeFile(path.join(repo, 'projects', 'registry.json'), JSON.stringify({ projects: [] }));
  const sessions = await new Sessions(repo, stateDir).init();
  return { repo, stateDir, sessions, archive: new PortableArchive(repo, stateDir, sessions, null) };
}

test('empty legacy Inbox exports canonically, imports existing archives, and still rejects malformed or tampered state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-empty-inbox-transfer-'));
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    await writeFile(path.join(source.stateDir, 'inbox.json'), '{}');
    await writeFile(path.join(target.stateDir, 'inbox.json'), '{}');
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    const entries = unzipSync(await readFile(exported.path));
    assert.deepEqual(JSON.parse(strFromU8(entries['state/inbox.json'])), { resources: [] });
    assert.equal(await readFile(path.join(source.stateDir, 'inbox.json'), 'utf8'), '{}', 'Export must not modify source state');
    const legacy = async (value, name, updateChecksum = true) => {
      const files = { ...entries, 'state/inbox.json': strToU8(JSON.stringify(value)) };
      const manifest = JSON.parse(strFromU8(files['manifest.json']));
      if (updateChecksum) {
        const item = manifest.files.find(file => file.name === 'state/inbox.json');
        item.size = files['state/inbox.json'].length;
        item.sha256 = createHash('sha256').update(files['state/inbox.json']).digest('hex');
      }
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
      const file = path.join(root, `${name}.mrmak.zip`); await writeFile(file, zipSync(files)); return file;
    };
    const oldArchive = await legacy({}, 'legacy');
    await target.archive.preview(oldArchive);
    await target.archive.importFrom(oldArchive);
    assert.deepEqual(JSON.parse(await readFile(path.join(target.stateDir, 'inbox.json'), 'utf8')), { resources: [] });
    const local = { resources: [{ id: 'local', kind: 'inbox', path: 'inbox/local.txt' }] };
    await writeFile(path.join(target.stateDir, 'inbox.json'), JSON.stringify(local));
    await target.archive.importFrom(oldArchive);
    assert.deepEqual(JSON.parse(await readFile(path.join(target.stateDir, 'inbox.json'), 'utf8')), local);
    for (const [index, value] of [null, [], { resources: null }, { resources: {} }, { resources: '' }].entries()) {
      await assert.rejects(target.archive.preview(await legacy(value, `invalid-${index}`)), /invalid state\/inbox\.json/);
    }
    await assert.rejects(target.archive.preview(await legacy({}, 'tampered', false)), /integrity/);
    const projects = new Projects(source.repo, source.stateDir);
    await rm(path.join(source.stateDir, 'inbox.json'));
    const project = await projects.save({ name: 'Temporary workspace', repositoryPath: '' });
    await projects.remove(project.id);
    assert.deepEqual(JSON.parse(await readFile(path.join(source.stateDir, 'inbox.json'), 'utf8')), { resources: [] });
  } finally {
    await source.sessions.close(); await target.sessions.close(); await rm(root, { recursive: true, force: true });
  }
});

test('portable full export imports Hub files, relinks projects and restores a Codex transcript without touching linked folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-portable-'));
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-home'); process.env.CODEX_HOME = codexHome;
  const source = await hub(root, 'PC1/MyHub'), target = await hub(root, 'PC2/MyHub');
  try {
    for (const pc of ['PC1', 'PC2']) {
      await mkdir(path.join(root, pc, 'App'), { recursive: true });
      await writeFile(path.join(root, pc, 'App/program.txt'), `${pc}-program`);
    }
    const oldProject = path.join(root, 'old-project'), newProject = path.join(root, 'new-project');
    await mkdir(oldProject); await mkdir(newProject);
    await writeFile(path.join(newProject, 'sentinel.txt'), 'never edit linked projects');
    await writeFile(path.join(source.repo, 'knowledge', 'lesson.md'), 'portable lesson');
    await writeFile(path.join(source.repo, 'processes', 'release.md'), '# Release steps');
    await writeFile(path.join(source.repo, 'inbox', 'reference.png'), 'fixture-image');
    await mkdir(path.join(source.repo, '.agents', 'skills', 'handoff'), { recursive: true });
    await mkdir(path.join(source.repo, '.claude', 'skills', 'handoff'), { recursive: true });
    await writeFile(path.join(source.repo, '.agents', 'skills', 'handoff', 'SKILL.md'), '# Codex handoff');
    await writeFile(path.join(source.repo, '.claude', 'skills', 'handoff', 'SKILL.md'), '# Claude handoff');
    await writeFile(path.join(source.repo, 'projects', 'skill-scopes.json'), JSON.stringify({ skills: { handoff: { global: true, projects: { [projectId]: false } } }, claudeSkills: { handoff: { global: false, projects: { [projectId]: true } } } }));
    await writeFile(path.join(source.repo, '.env'), 'PRIVATE_KEY=must-not-export');
    await writeFile(path.join(source.repo, 'projects', 'registry.json'), JSON.stringify({ projects: [{ id: projectId, name: 'Game', repositories: [{ id: 'primary', name: 'Unity' }] }] }));
    await writeFile(path.join(source.repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [{ id: 'card', title: 'Gameplay', folder: 'gameplay', projectId, repositoryId: 'primary', pinned: true, steps: [] }], resources: [{ id: 'lesson', kind: 'knowledge', path: 'knowledge/lesson.md', title: 'Lesson', projectId }] }));
    await writeFile(path.join(source.stateDir, 'inbox.json'), JSON.stringify({ resources: [{ id: 'reference', kind: 'inbox', path: 'inbox/reference.png', title: 'Reference', projectId }] }));
    await writeFile(path.join(source.stateDir, 'settings.json'), JSON.stringify({ defaultAgent: 'claude', defaultBypass: true, terminalAppearance: 'original', completionNotifications: false, accentTheme: 'blue', selectedProjectId: projectId, selectedId: id, workspaceRoute: '#/old' }));
    await writeFile(path.join(source.stateDir, 'project-locations.json'), JSON.stringify({ [projectId]: { repositoryPath: oldProject, repositories: { primary: oldProject } } }));
    const chat = { id, agent: 'codex', nativeId: id, name: 'Unity chat', cwd: oldProject, projectId, repositoryId: 'primary', open: false, status: 'stopped', createdAt: new Date().toISOString() };
    source.sessions.items.set(id, source.sessions.make(chat)); await source.sessions.persist();
    const transcript = path.join(codexHome, 'sessions', '2026', '09', '28', `rollout-${id}.jsonl`);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: oldProject } }) + '\n');
    const planningId = randomUUID(), legacyPlanningId = randomUUID(), hubChatId = randomUUID();
    for (const chat of [
      { id: planningId, cwd: path.join(source.repo, 'workspace', 'planning', projectId), projectId },
      { id: legacyPlanningId, cwd: path.join(root, 'former-local-chat'), projectId },
      { id: hubChatId, cwd: source.repo, projectId: null },
    ]) source.sessions.items.set(chat.id, source.sessions.make({ ...chat, agent: 'codex', name: 'Planning fixture', repositoryId: null, open: false, hasConversation: false }));
    const exported = await source.archive.exportTo(root, { chats: 'full' });
    const preview = await target.archive.preview(exported.path);
    assert.equal(preview.manifest.files.some(file => /program\.txt|(^|\/)App\//.test(file.name)), false);
    assert.equal(preview.native[0].status, 'identical');
    assert.ok(!preview.manifest.files.some(file => file.name.includes('.env')));
    const imported = await target.archive.importFrom(exported.path, { relinks: { [projectId]: { primary: newProject } } });
    assert.equal(imported.nativeSkipped, 1);
    assert.equal(target.sessions.get(id).cwd, await realpath(newProject));
    const planning = path.join(target.repo, 'workspace', 'planning', projectId);
    assert.equal(target.sessions.get(planningId).cwd, planning);
    assert.equal(target.sessions.get(legacyPlanningId).cwd, planning);
    assert.equal(target.sessions.get(hubChatId).cwd, target.repo);
    assert.equal(await readFile(path.join(target.repo, 'knowledge', 'lesson.md'), 'utf8'), 'portable lesson');
    assert.equal(await readFile(path.join(target.repo, 'processes', 'release.md'), 'utf8'), '# Release steps');
    assert.equal(await readFile(path.join(target.repo, 'inbox', 'reference.png'), 'utf8'), 'fixture-image');
    assert.equal(JSON.parse(await readFile(path.join(target.repo, 'workspace', 'workspace.json'), 'utf8')).entities[0].pinned, true);
    assert.equal(JSON.parse(await readFile(path.join(target.stateDir, 'inbox.json'), 'utf8')).resources[0].projectId, projectId);
    assert.equal((await stat(path.join(target.stateDir, 'settings.json')).catch(() => null)), null);
    const restored = await target.archive.importFrom(exported.path, { restoreSettings: true });
    assert.equal(restored.restoredSettings.defaultBypass, true);
    const preferences = JSON.parse(await readFile(path.join(target.stateDir, 'settings.json'), 'utf8'));
    assert.equal(preferences.defaultAgent, 'claude');
    assert.equal(preferences.accentTheme, 'blue');
    assert.equal(preferences.completionNotifications, false);
    assert.equal(preferences.selectedProjectId, projectId);
    assert.equal(preferences.selectedId, undefined);
    assert.equal(preferences.workspaceRoute, undefined);
    assert.equal(await readFile(path.join(target.repo, '.agents', 'skills', 'handoff', 'SKILL.md'), 'utf8'), '# Codex handoff');
    assert.equal(await readFile(path.join(target.repo, '.claude', 'skills', 'handoff', 'SKILL.md'), 'utf8'), '# Claude handoff');
    const importedSkillScopes = JSON.parse(await readFile(path.join(target.repo, 'projects', 'skill-scopes.json'), 'utf8'));
    assert.equal(importedSkillScopes.skills.handoff.global, true);
    assert.equal(importedSkillScopes.skills.handoff.projects[projectId], false);
    assert.equal(importedSkillScopes.claudeSkills.handoff.projects[projectId], true);
    assert.equal((await stat(path.join(target.repo, '.env')).catch(() => null)), null);
    assert.equal(await readFile(path.join(root, 'PC1/App/program.txt'), 'utf8'), 'PC1-program');
    assert.equal(await readFile(path.join(root, 'PC2/App/program.txt'), 'utf8'), 'PC2-program');
    assert.equal(await readFile(path.join(newProject, 'sentinel.txt'), 'utf8'), 'never edit linked projects');
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  }
});

test('full export includes Claude session sidecars; light export keeps only Mr. Mik History', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-claude-portable-'));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');
  const source = await hub(root, 'source'), target = await hub(root, 'target');
  try {
    const chat = { id, agent: 'claude', nativeId: id, name: 'Research', cwd: source.repo, open: false, status: 'stopped', createdAt: new Date().toISOString() };
    source.sessions.items.set(id, source.sessions.make(chat)); await source.sessions.persist();
    const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', source.repo.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(path.join(folder, id, 'tool-results'), { recursive: true });
    await writeFile(path.join(folder, `${id}.jsonl`), '{"type":"user"}\n');
    await writeFile(path.join(folder, id, 'tool-results', 'result.txt'), 'generated result');
    await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id), { recursive: true });
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id, '1.json'), '{"status":"pending"}');
    await mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id), { recursive: true });
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id, 'snapshot.txt'), 'checkpoint');
    const full = await source.archive.exportTo(root, { chats: 'full' });
    assert.ok((await source.archive.preview(full.path)).manifest.files.some(file => file.name.endsWith('tool-results/result.txt')));
    assert.ok((await source.archive.preview(full.path)).manifest.files.some(file => file.name.includes('_mrmak-state/tasks/')));
    const pc1 = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'pc2');
    await target.archive.importFrom(full.path);
    assert.equal(await readFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks', id, '1.json'), 'utf8'), '{"status":"pending"}');
    assert.equal(await readFile(path.join(process.env.CLAUDE_CONFIG_DIR, 'file-history', id, 'snapshot.txt'), 'utf8'), 'checkpoint');
    // Relinking the Hub again keeps the existing native transcript at its source.
    const next = await hub(root, 'next');
    try {
      await next.archive.importFrom(full.path);
      assert.equal(next.sessions.list()[0].cwd, next.repo);
      assert.equal(await stat(await claudeTranscript(next.repo, id)).catch(() => null), null);
      assert.ok(await stat(await claudeTranscript(next.repo, id, { search: true })));
      assert.equal((await next.archive.exportTo(root, { chats: 'full' })).chats, 1);
    } finally { await next.sessions.close(); }
    process.env.CLAUDE_CONFIG_DIR = pc1;
    const light = await source.archive.exportTo(root, { chats: 'light' });
    const preview = await target.archive.preview(light.path);
    assert.equal(preview.native.length, 0);
    assert.equal(preview.manifest.chats, 'light');
  } finally {
    await source.sessions.close(); await target.sessions.close();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
  }
});
