import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { unlink, copyFile, mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, createService } from './fixtures.mjs';
import { ClaudeProfiles } from '../claude-profiles.mjs';
import { ClaudeChat } from '../claude-chat.mjs';
import { claudeFixture } from './claude-chat-fixture.mjs';
import { writeClaudeHistory } from './claude-history-fixture.mjs';
import { PortableArchive } from '../portable-archive.mjs';
import { Sessions } from '../sessions.mjs';
import { NativeDeletion } from '../native-delete.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { createClaudeMessageBranch } from '../claude-message-actions.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-claude-profiles-')), home = path.join(root, 'home'), current = path.join(home, '.claude');
  await mkdir(current, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home }; delete env.CLAUDE_CONFIG_DIR;
  const profiles = new ClaudeProfiles({ root: path.join(root, 'accounts'), home, env, identity: async env => ({ status: 'logged-in', email: 'synthetic@example.test', identity: env.CLAUDE_CONFIG_DIR || 'current' }) });
  return { root, home, current, env, profiles };
}

test('current Claude uses native configuration directly; new profiles start empty and strip inherited account overrides', async () => {
  const { profiles, current, home } = await setup(); await writeFile(path.join(current, 'sentinel.txt'), 'KEEP ORIGINAL');
  Object.assign(profiles.env, { ANTHROPIC_API_KEY: 'NEVER_INHERIT', ANTHROPIC_BASE_URL: 'http://synthetic.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'NEVER_INHERIT', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
  const original = await profiles.context(); assert.equal(original.directory, current); assert.equal(original.env.CLAUDE_CONFIG_DIR, undefined);
  const row = await profiles.create(), context = await profiles.context(row.id);
  assert.deepEqual(await readdir(context.directory), []); assert.equal(context.env.HOME, home); assert.equal(context.env.USERPROFILE, home);
  assert.equal(context.env.CLAUDE_CONFIG_DIR, context.directory); assert.equal(context.env.ANTHROPIC_API_KEY, undefined); assert.equal(context.env.ANTHROPIC_BASE_URL, undefined); assert.equal(context.env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(context.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  assert.equal(await readFile(path.join(current, 'sentinel.txt'), 'utf8'), 'KEEP ORIGINAL');
});

test('existing Claude directory is linked without copies; overlap, missing profile and removed associations fail closed', async () => {
  const { profiles, root, current } = await setup(), directory = path.join(root, 'existing'); await mkdir(directory); await writeFile(path.join(directory, 'sentinel.txt'), 'EXISTING');
  const row = await profiles.create('Existing', directory); assert.equal((await profiles.context(row.id)).directory, directory);
  assert.deepEqual(await readdir(directory), ['sentinel.txt']);
  await assert.rejects(profiles.create('Duplicate', directory), /overlap/); await assert.rejects(profiles.create('Current', current), /overlap/);
  await profiles.remove(row.id); assert.equal(await readFile(path.join(directory, 'sentinel.txt'), 'utf8'), 'EXISTING');
  await assert.rejects(profiles.context(row.id), /not substituted/);
  const restored = await profiles.create('Restored', directory); assert.equal(restored.id, row.id); assert.equal((await profiles.context(row.id)).directory, directory);
});

test('native Claude history and portable reads never search another profile for a missing transcript', async () => {
  const { profiles, current, root } = await setup(), row = await profiles.create(), context = await profiles.context(row.id), cwd = path.join(root, 'work'); await mkdir(cwd);
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd, agent: 'claude', accountProfileId: row.id };
  const { file } = await writeClaudeHistory(context.directory, cwd, session.nativeId, 2); await writeClaudeHistory(current, cwd, session.nativeId, 1);
  const sessions = { accountContext: s => profiles.context(s.accountProfileId), repo: cwd }, archive = new PortableArchive(cwd, path.join(cwd, '.mrmak'), sessions, null);
  assert.equal(await archive.claudeFile(session, session.nativeId, { search: true }), file);
  const moved = path.join(context.directory, 'projects', 'former-working-folder', path.basename(file));
  const duplicate = path.join(context.directory, 'projects', 'duplicate-working-folder', path.basename(file));
  await mkdir(path.dirname(moved), { recursive: true });
  await mkdir(path.dirname(duplicate), { recursive: true });
  await rename(file, moved);
  assert.equal(await archive.claudeFile(session, session.nativeId, { search: true }), moved);
  await copyFile(moved, duplicate);
  await assert.rejects(archive.claudeFile(session, session.nativeId, { search: true }), /Multiple native/);
  await unlink(duplicate);
  await rename(moved, file + '.retained');
  assert.notEqual(await archive.claudeFile(session, session.nativeId, { search: true }), path.join(current, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.nativeId}.jsonl`));
  await profiles.remove(row.id); await assert.rejects(archive.claudeFile(session), /not substituted/);
});

test('pending Claude identity verification blocks configuration and starts no model work', async t => {
  const { root } = await setup(), session = { id: randomUUID(), nativeId: randomUUID(), agent: 'claude', cwd: root }, wire = claudeFixture(session.nativeId);
  const runtime = new ClaudeChat({ session, stateDir: root, transportFactory: wire.factory }); await runtime.start(); t.after(async () => { await runtime.close(); wire.close(); });
  let finish; runtime.verifyIdentity = () => new Promise(resolve => { finish = resolve; });
  const pending = runtime.submit('Synthetic input'); await Promise.resolve();
  assert.equal(runtime.idle(), false); assert.equal(runtime.snapshot().configuring, true); assert.equal(wire.calls.filter(call => call.type === 'user').length, 0);
  await assert.rejects(runtime.configure('fixture-sonnet', 'low'), /Finish/);
  finish(); await pending; assert.equal(wire.calls.filter(call => call.type === 'user').length, 1); assert.equal(runtime.snapshot().configuring, false);
});

test('Claude branch preflight verifies source profile before reading or forking native history', async () => {
  let reads = 0;
  const runtime = { idle: () => true, pending: { pending: false }, changed() {}, history: { read: async () => { reads++; } } }, source = { graphical: runtime, process: runtime };
  await assert.rejects(createClaudeMessageBranch({ sessions: { verifyIdentity: async () => { throw new Error('Original profile changed'); } }, source, itemId: 'synthetic', kind: 'branch' }), /Original profile changed/);
  assert.equal(reads, 0); assert.equal(runtime.messageActionBusy, false);
});

test('service routes selected Claude profile through launch, persistence, send identity and scoped tools', async t => {
  const { root, home, env } = await setup(), repo = path.join(root, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true }); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[],"resources":[]}');
  const service = await createService({ repo, mcpOptions: { home, env }, profileOptions: { root: path.join(root, 'registry') } });
  t.after(() => service.close());
  service.claudeProfiles.identity = async env => ({ status: 'logged-in', identity: env.CLAUDE_CONFIG_DIR || 'current', email: 'synthetic@example.test' });
  service.sessions.captureTools = async () => ({}); service.sessions.prepareLaunch = async () => null; service.sessions.prepareBrowser = async () => null;
  const launches = [];
  service.sessions.createGraphicalRuntime = options => { const wire = claudeFixture(options.session.nativeId); launches.push({ ...options, wire }); return new ClaudeChat({ ...options, transportFactory: wire.factory }); };
  const row = await service.claudeProfiles.create('Work'), profile = await service.claudeProfiles.context(row.id);
  const created = await service.sessions.create({ agent: 'claude', chatInterface: 'chat', cwd: repo, accountProfileId: row.id });
  const session = service.sessions.get(created.id);
  assert.equal(launches[0].env.CLAUDE_CONFIG_DIR, profile.directory); assert.equal(created.accountProfileId, row.id); assert.equal(created.accountProfileLabel, 'Work');
  await session.graphical.submit('brief synthetic input'); await service.sessions.persist();
  const stored = JSON.parse(await readFile(path.join(repo, '.mrmak/sessions.json'), 'utf8')); assert.equal(stored.find(item => item.id === created.id).accountProfileId, row.id);
  service.claudeProfiles.identity = async () => ({ status: 'logged-in', identity: 'changed' });
  const before = launches[0].wire.calls.length; await assert.rejects(session.graphical.submit('must not send'), /identity changed/); assert.equal(launches[0].wire.calls.length, before);
  const headers = { Authorization: `Bearer ${service.token}` };
  const response = await fetch(`${service.origin}/api/claude/mcp-managed?scope=global&profileId=${row.id}`, { headers }); assert.equal(response.status, 200);
  await service.sessions.stop(created.id);
});

test('permanent native deletion stays inside the conversation’s Claude profile', async t => {
  const { root, profiles, current } = await setup(), row = await profiles.create(), context = await profiles.context(row.id), cwd = path.join(root, 'work'); await mkdir(cwd);
  const sessions = await new Sessions(cwd, path.join(cwd, '.mrmak')).init(); sessions.accountContext = session => profiles.context(session.accountProfileId); t.after(() => sessions.close());
  const session = sessions.make({ id: randomUUID(), nativeId: randomUUID(), agent: 'claude', accountProfileId: row.id, cwd, name: 'Synthetic scoped deletion', open: false, hasConversation: true }); sessions.items.set(session.id, session);
  const owned = await writeClaudeHistory(context.directory, cwd, session.nativeId, 1), original = await writeClaudeHistory(current, cwd, session.nativeId, 1);
  const deletion = new NativeDeletion(sessions, sessions.stateDir), plan = await deletion.plan(session.id);
  assert.equal(plan.files[0], owned.file); await deletion.confirm(session.id, plan.token, session.name);
  await assert.rejects(readFile(owned.file), /ENOENT/); assert.ok(await readFile(original.file, 'utf8'));
});

test('full export selects the Claude profile transcript and companions, excluding its credentials and registry', async t => {
  const { root, profiles, current } = await setup(), row = await profiles.create(), context = await profiles.context(row.id), cwd = path.join(root, 'hub');
  for (const folder of ['workspace', 'projects', 'knowledge', '.mrmak']) await mkdir(path.join(cwd, folder), { recursive: true });
  await writeFile(path.join(cwd, 'workspace/workspace.json'), '{"entities":[],"resources":[]}'); await writeFile(path.join(cwd, 'projects/registry.json'), '{"projects":[]}');
  const sessions = await new Sessions(cwd, path.join(cwd, '.mrmak')).init(); sessions.accountContext = session => profiles.context(session.accountProfileId); t.after(() => sessions.close());
  const session = sessions.make({ id: randomUUID(), nativeId: randomUUID(), agent: 'claude', accountProfileId: row.id, cwd, name: 'Export fixture', open: false, hasConversation: true }); sessions.items.set(session.id, session);
  await writeClaudeHistory(current, cwd, session.nativeId, 1); const own = await writeClaudeHistory(context.directory, cwd, session.nativeId, 2);
  await mkdir(path.join(context.directory, 'tasks', session.nativeId), { recursive: true }); await writeFile(path.join(context.directory, 'tasks', session.nativeId, 'task.json'), '{"synthetic":"WORK_PROFILE"}');
  await writeFile(path.join(context.directory, '.credentials.json'), '{"secret":"NEVER_COPY_AUTH"}');
  const archive = new PortableArchive(cwd, sessions.stateDir, sessions, null), result = await archive.exportTo(root), zip = unzipSync(await readFile(result.path));
  assert.equal(strFromU8(zip[`native/claude/${session.nativeId}.jsonl`]), await readFile(own.file, 'utf8'));
  assert.match(strFromU8(zip[`native/claude/${session.nativeId}/_mrmak-state/tasks/task.json`]), /WORK_PROFILE/);
  assert.doesNotMatch(Object.keys(zip).join('\n'), /credentials|profiles.json/);
  assert.doesNotMatch(strFromU8(zip['state/sessions.json']), /NEVER_COPY_AUTH/);
});
