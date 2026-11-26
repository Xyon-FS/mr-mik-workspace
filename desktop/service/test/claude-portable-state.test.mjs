import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdtemp } from './fixtures.mjs';
import { Sessions } from '../sessions.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { portableClaudeState, relocateClaudeState } from '../claude-portable-state.mjs';
import { claudeAttachmentInput } from '../claude-chat-attachments.mjs';
import { writeClaudeHistory } from './claude-history-fixture.mjs';

test('Claude full archive preserves draft, local references and branch origin without account or transport state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-transfer-')), oldConfig = process.env.CLAUDE_CONFIG_DIR, hubs = [];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'profile');
  try {
    const hub = async name => {
      const repo = path.join(root, name), stateDir = path.join(repo, '.mrmak');
      for (const folder of ['.mrmak', 'knowledge', 'workspace', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
      await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}'); await writeFile(path.join(repo, 'projects/registry.json'), '{"projects":[]}');
      const sessions = await new Sessions(repo, stateDir).init(), archive = new PortableArchive(repo, stateDir, sessions, null);
      const result = { repo, stateDir, sessions, archive }; hubs.push(result); return result;
    };
    const source = await hub('source'), target = await hub('target');
    const parent = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd: source.repo, open: false, hasConversation: true, updatedAt: '2026-10-28T20:00:00Z' };
    const child = { ...parent, id: randomUUID(), nativeId: randomUUID(), chatInterface: 'chat', messageOrigin: { sessionId: parent.id, threadId: parent.nativeId, itemId: 'answer:0', kind: 'branch' } };
    for (const session of [child, parent]) { source.sessions.items.set(session.id, source.sessions.make(session)); await writeClaudeHistory(process.env.CLAUDE_CONFIG_DIR, source.repo, session.nativeId, 2); }
    const local = path.join(source.repo, 'knowledge', 'reference.txt'); await writeFile(local, 'Synthetic local reference');
    const external = path.join(root, 'external.png');
    const saved = { version: 1, repo: source.stateDir, nativeId: child.nativeId, draft: 'Keep my draft', buildPermissionMode: 'acceptEdits', auth: 'NEVER_ACCOUNT', attachments: [{ path: local, resolvedPath: local, name: 'reference.txt', kind: 'file' }, { path: external, resolvedPath: external, name: 'external.png', kind: 'image' }], state: { status: 'ready', items: [{ id: 'input', turnId: 'turn', type: 'userMessage', text: 'Synthetic input' }], turns: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 2 }], requests: [{ token: 'NEVER_TRANSPORT' }] } };
    await writeFile(path.join(source.stateDir, `claude-chat-${child.id}.json`), JSON.stringify(saved));
    const exported = await source.archive.exportTo(root), zip = unzipSync(await readFile(exported.path));
    const display = strFromU8(zip[`state/claude-chat-${child.id}.json`]); assert.doesNotMatch(display, /NEVER_|token|auth/);
    assert.ok(JSON.parse(strFromU8(zip['manifest.json'])).transfer.required.includes('claude-display-v1'));
    await target.archive.importFrom(exported.path);
    const restored = JSON.parse(await readFile(path.join(target.stateDir, `claude-chat-${child.id}.json`), 'utf8'));
    assert.equal(restored.buildPermissionMode, 'acceptEdits'); assert.equal(restored.draft, saved.draft); assert.equal(restored.repo, target.stateDir); assert.deepEqual(restored.state.requests, []);
    assert.equal(restored.attachments[0].path, path.join(target.repo, 'knowledge', 'reference.txt')); assert.equal(restored.attachments[1].unavailable, true);
    await assert.rejects(claudeAttachmentInput('Do not send', [restored.attachments[1]]), /unavailable/);
    assert.equal(target.sessions.get(child.id).messageOrigin.sessionId, parent.id);
    await target.archive.importFrom(exported.path); assert.equal(target.sessions.list().length, 2);
    // A subsequent archive without graphical state must preserve local bytes.
    const localDisplay = path.join(target.stateDir, `claude-chat-${child.id}.json`), before = await readFile(localDisplay, 'utf8');
    await unlink(path.join(source.stateDir, `claude-chat-${child.id}.json`));
    source.sessions.get(child.id).updatedAt = '2026-10-29T20:00:00Z';
    const legacy = await source.archive.exportTo(root);
    await target.archive.importFrom(legacy.path); assert.equal(await readFile(localDisplay, 'utf8'), before);
  } finally {
    await Promise.all(hubs.map(hub => hub.sessions.close()));
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
  }
});
test('Claude display contract rejects wrong identity and rebases only Hub/project references', () => {
  const session = { nativeId: randomUUID() }, root = path.resolve('synthetic-source'), target = path.resolve('synthetic-target');
  const value = { version: 1, nativeId: session.nativeId, draft: '', attachments: [], state: { items: [], turns: [], requests: [{ private: true }] } };
  assert.throws(() => portableClaudeState({ ...value, nativeId: randomUUID() }, session), /Invalid portable/);
  assert.throws(() => portableClaudeState({ ...value, state: { ...value.state, items: [{ id: 'input', type: 'userMessage', text: '', nativeUuid: { token: 'NEVER_COPY' } }] } }, session), /Invalid portable/);
  assert.equal(relocateClaudeState(value, session, { sourceHub: root, destinationHub: target, sourceCwd: root, destinationCwd: target, stateDir: path.join(target, '.mrmak') }).repo, path.join(target, '.mrmak'));
});
