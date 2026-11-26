import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeSettings, openCodeDocument } from '../opencode-settings.mjs';
import { McpInventory } from '../mcp.mjs';
import { accountCommand, accountStatusCommand, parseAccountStatus } from '../accounts.mjs';

async function fixture(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-v2-settings-'));
  const home = path.join(base, 'home'), root = path.join(base, 'project'), stateDir = path.join(base, 'state'), globalFile = path.join(home, '.config/opencode/opencode.jsonc');
  try {
    for (const folder of [path.dirname(globalFile), path.join(root, '.opencode/skills/report'), path.join(root, '.git'), stateDir]) await mkdir(folder, { recursive: true });
    await writeFile(path.join(root, '.opencode/skills/report/SKILL.md'), '---\nname: report\ndescription: Fixture\n---\nFixture');
    await writeFile(globalFile, '// preserved\n' + JSON.stringify({ mcp: { timeout: { catalog: 1000 }, servers: { fixture: { type: 'local', command: ['node', 'fixture.mjs'], disabled: true, environment: { AUTH: '{env:FIXTURE_AUTH}' } } } }, permissions: [{ action: 'skill', resource: '*', effect: 'deny' }], plugins: [{ package: 'fixture-plugin', options: { token: 'FIXTURE_SECRET' } }] }));
    const settings = new OpenCodeSettings({ root: async () => root }, stateDir, { home, env: {}, family: 2 });
    await run({ base, home, root, stateDir, globalFile, settings });
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
test('V2 MCP toggle writes valid transport, not ignored sparse enabled entries, and Inherit removes only its unchanged generated override', async () => fixture(async f => {
  const globalBytes = await readFile(f.globalFile);
  const source = await openCodeDocument(f.globalFile);
  source.value.mcp.servers.fixture.environment.AUTH = 'FIXTURE_LITERAL_SECRET';
  await writeFile(f.globalFile, JSON.stringify(source.value));
  await assert.rejects(f.settings.change({ projectId: 'workspace', name: 'fixture', enabled: true }), /credentials/);
  await assert.rejects(readFile(path.join(f.root, 'opencode.json')), { code: 'ENOENT' });
  await writeFile(f.globalFile, globalBytes);
  const args = { projectId: 'workspace', scope: 'project', name: 'fixture' };
  await f.settings.change({ ...args, enabled: true });
  let doc = await openCodeDocument(path.join(f.root, 'opencode.json'));
  assert.deepEqual(doc.value.mcp.servers.fixture, { type: 'local', command: ['node', 'fixture.mjs'], environment: { AUTH: '{env:FIXTURE_AUTH}' }, disabled: false });
  assert.equal(JSON.stringify(doc.value).includes('FIXTURE_SECRET'), false);
  const list = await f.settings.list('workspace'); assert.equal(list.rows.find(row => row.kind === 'mcp').effective, true); assert.equal(JSON.stringify(list).includes('FIXTURE_SECRET'), false);
  const inventory = new McpInventory(f.root, { home: f.home, env: {} });
  try {
    const result = await inventory.list();
    const servers = result.servers.filter(row => row.client === 'opencode');
    assert.equal(servers.length, 1);
    assert.equal(servers[0].enabled, true);
    assert.doesNotMatch(JSON.stringify(result), /FIXTURE_SECRET/);
  } finally { inventory.close(); }
  await f.settings.change({ ...args, enabled: false }); await f.settings.change({ ...args, enabled: null });
  assert.equal((await openCodeDocument(doc.file)).value.mcp.servers.fixture, undefined);
  assert.match(await readFile(f.globalFile, 'utf8'), /preserved/);
  await f.settings.change({ ...args, enabled: true });
  doc = await openCodeDocument(doc.file); doc.value.mcp.servers.fixture.command = ['node', 'externally-edited.mjs'];
  await writeFile(doc.file, JSON.stringify(doc.value)); await f.settings.change({ ...args, enabled: null });
  assert.deepEqual((await openCodeDocument(doc.file)).value.mcp.servers.fixture.command, ['node', 'externally-edited.mjs']);
}));

test('V2 plugin controls require native identity proof and edit only exact ID exclusions', async () => fixture(async f => {
  const args = { projectId: 'workspace', scope: 'project', kind: 'plugin', name: 'actual.fixture.id' };
  await assert.rejects(f.settings.change({ ...args, enabled: false }), /Verify/);
  f.settings.observePlugins(f.root, [{ id: args.name, source: { type: 'package', target: 'fixture-plugin' }, status: 'active' }, { id: 'builtin', source: { type: 'builtin' }, status: 'active' }]);
  const known = (await f.settings.list('workspace')).rows.find(row => row.id === args.name);
  assert.equal(known.globalEditable, true); assert.equal(known.projectEditable, true);
  await f.settings.change({ ...args, enabled: false });
  const doc = await openCodeDocument(path.join(f.root, 'opencode.json'));
  assert.deepEqual(doc.value.plugins, ['-actual.fixture.id']);
  assert.equal(doc.source.includes('FIXTURE_SECRET'), false);
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.id === args.name).projectOverride, false);
  await f.settings.change({ ...args, enabled: true });
  assert.equal((await openCodeDocument(doc.file)).value.plugins, undefined);
  await f.settings.change({ ...args, scope: 'global', enabled: false });
  await assert.rejects(f.settings.change({ ...args, enabled: true }), /inherited or wildcard/);
  await f.settings.change({ ...args, scope: 'global', enabled: true });
  assert.equal((await openCodeDocument(f.globalFile)).value.plugins[0].options.token, 'FIXTURE_SECRET');
  await writeFile(doc.file, '{"plugins":["-actual.*"]}');
  await assert.rejects(f.settings.change({ ...args, enabled: true }), /wildcard/);
  const reopened = new OpenCodeSettings({ root: async () => f.root }, f.stateDir, { home: f.home, env: {}, family: 2 });
  await assert.rejects(reopened.change({ ...args, enabled: false }), /Verify/);
}));
test('V2 ordered skill permissions preserve unrelated rules; inherited wildcard denial can be overridden and restored', async () => fixture(async f => {
  const args = { projectId: 'workspace', scope: 'project', kind: 'skill', name: 'report' };
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.kind === 'skill').effective, false);
  const projectFile = path.join(f.root, 'opencode.json');
  await writeFile(projectFile, JSON.stringify({ permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }));
  await f.settings.change({ ...args, enabled: true });
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.kind === 'skill').effective, true);
  await f.settings.change({ ...args, enabled: null });
  assert.deepEqual((await openCodeDocument(projectFile)).value.permissions, [{ action: 'shell', resource: '*', effect: 'ask' }]);
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.kind === 'skill').effective, false);
  await f.settings.change({ ...args, scope: 'global', enabled: true });
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.kind === 'skill').globalEnabled, true);
}));
test('V2 owned definitions use native disabled and external definitions remain protected', async () => fixture(async f => {
  await assert.rejects(f.settings.change({ scope: 'global', action: 'remove', name: 'fixture' }), /outside/);
  await f.settings.change({ projectId: 'workspace', action: 'save', name: 'owned', transport: 'stdio', command: 'node' });
  assert.equal((await f.settings.managed('workspace')).servers.find(row => row.name === 'owned').managed, true);
  await f.settings.change({ projectId: 'workspace', name: 'owned', enabled: false });
  await f.settings.change({ projectId: 'workspace', action: 'remove', name: 'owned' });
  assert.equal((await openCodeDocument(path.join(f.root, 'opencode.json'))).value.mcp.servers.owned, undefined);
}));
test('V2 auth uses native positional integration/private server and exposes fixed enums only', () => {
  const resolve = { opencode: () => ({ file: 'fixture.exe', args: [] }), openCodeFamily: () => 2 };
  assert.deepEqual(accountCommand('opencode', 'login', resolve).args, ['auth', 'login', '--standalone']);
  assert.deepEqual(accountCommand('opencode', 'logout', resolve).args, ['auth', 'logout', '--standalone']);
  assert.deepEqual(accountStatusCommand('opencode', resolve).args, ['auth', 'list', '--standalone', '--format', 'json']);
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: JSON.stringify([{ id: 'openai', connections: [{ label: 'PRIVATE_LABEL', token: 'FIXTURE_SECRET' }] }]) }), 'logged-in');
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: '[]' }), 'logged-out');
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: '[{"id":"other","connections":[{}]}]' }), 'logged-in');
  assert.equal(parseAccountStatus('opencode', { code: 0, stdout: '{}' }), 'unknown');
});

test('V2 remote/custom catalog is metadata-only and revalidated; ask is not an unconditional allow', async () => fixture(async f => {
  const doc = await openCodeDocument(f.globalFile);
  doc.value.skills = ['https://example.invalid/skills'];
  doc.value.permissions = [{ action: 'skill', resource: '*', effect: 'ask' }];
  await writeFile(f.globalFile, JSON.stringify(doc.value));
  f.settings.inspectSkills = async () => [{ id: 'remote.ID', name: 'Remote display', path: path.join(f.base, 'native-cache/remote.ID/SKILL.md'), content: 'PRIVATE_BODY', token: 'PRIVATE_TOKEN' }];
  let row = (await f.settings.list('workspace')).rows.find(row => row.id === 'remote.ID');
  assert.equal(row.nativeVerified, true); assert.equal(row.permissionEffect, 'ask'); assert.equal(row.requiresApproval, true);
  assert.equal(JSON.stringify(row).includes('PRIVATE'), false);
  await f.settings.change({ projectId: 'workspace', kind: 'skill', id: row.id, enabled: false });
  assert.equal((await f.settings.list('workspace')).rows.find(row => row.id === row.id).effective, false);
  f.settings.inspectSkills = async () => [];
  await assert.rejects(f.settings.change({ projectId: 'workspace', kind: 'skill', id: row.id, enabled: true }), /discovered/);
}));
