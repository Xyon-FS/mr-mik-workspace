import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, readdir, rename, symlink } from 'node:fs/promises';
import { parse as toml } from 'smol-toml';
import { mkdtemp, createService } from './fixtures.mjs';
import { McpRecovery } from '../mcp-recovery.mjs';
import { McpInventory } from '../mcp.mjs';
import { Projects } from '../projects.mjs';

async function fixture(local = '[mcp_servers.demo]\ncommand="C:/missing/mcp-fixture.exe"\nargs=[]\n') {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mik-mcp-recovery-'));
  const hub = path.join(base, 'hub'), root = path.join(base, 'project'), home = path.join(base, 'home'), state = path.join(hub, '.mrmak');
  for (const folder of [state, path.join(hub, 'workspace'), path.join(hub, 'ui'), path.join(root, '.codex'), path.join(home, '.codex')]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(hub, 'workspace/workspace.json'), '{"entities":[]}');
  await writeFile(path.join(hub, 'ui/index.html'), '<html>Fixture</html>');
  const globalFile = path.join(home, '.codex/config.toml'), localFile = path.join(root, '.codex/config.toml');
  const globalText = `[mcp_servers.demo]\ncommand=${JSON.stringify(process.execPath)}\nargs=[]\n# private global comment\n`;
  await writeFile(globalFile, globalText); await writeFile(localFile, local);
  const projects = new Projects(hub, state), project = await projects.save({ name: 'Fixture', repositoryPath: root });
  const options = { home, env: {} };
  const recovery = new McpRecovery(projects, state, options), inventory = new McpInventory(root, options);
  const request = { projectId: project.id, repositoryId: 'primary', name: 'demo' };
  return { base, hub, root, home, state, projects, project, localFile, globalFile, globalText, recovery, inventory, request, options };
}

test('recovery removes only the local table, preserves unrelated values/comments and supports exact undo', async () => {
  const local = '# local intro\nmodel="fixture"\n[mcp_servers.demo]\ncommand="C:/missing/mcp-fixture.exe"\n[mcp_servers.demo.env]\nSECRET="fixture-only-secret"\n# keep neighbour comment\n[mcp_servers.other]\nurl="https://example.invalid/mcp"\n';
  const f = await fixture(local);
  const before = await f.inventory.list();
  assert.equal(before.servers.find(row => row.name === 'demo').readiness, 'missing-command');
  assert.deepEqual((await f.recovery.candidates(f.request, before)).map(row => row.name), ['demo']);
  const preview = await f.recovery.preview(f.request);
  assert.equal(preview.globalHealth, 'not-checked');
  assert.ok(!JSON.stringify(preview).includes('fixture-only-secret'));
  const result = await f.recovery.apply(preview.token);
  const updated = await readFile(f.localFile, 'utf8');
  assert.equal(toml(updated).mcp_servers.demo, undefined);
  assert.ok(updated.includes('# keep neighbour comment'));
  assert.deepEqual(toml(updated).mcp_servers.other, toml(local).mcp_servers.other);
  assert.equal(await readFile(f.globalFile, 'utf8'), f.globalText);
  assert.equal(await readFile(result.backup, 'utf8'), local);
  assert.equal((await f.inventory.list()).servers.find(row => row.name === 'demo').readiness, 'configured');
  await f.recovery.undo(result.undoToken);
  assert.equal(await readFile(f.localFile, 'utf8'), local);
});

test('recovery refuses changed local/global files; undo refuses subsequent edits', async () => {
  const f = await fixture();
  const review = await f.recovery.preview(f.request);
  await writeFile(f.globalFile, f.globalText + '# changed\n');
  await assert.rejects(f.recovery.apply(review.token), /Global configuration changed/);
  await writeFile(f.globalFile, f.globalText);
  await writeFile(f.localFile, (await readFile(f.localFile, 'utf8')) + '# local changed\n');
  await assert.rejects(f.recovery.apply(review.token), /Local configuration changed/);
  const fresh = await f.recovery.preview(f.request), result = await f.recovery.apply(fresh.token);
  const next = await readFile(f.localFile, 'utf8') + '# after recovery\n';
  await writeFile(f.localFile, next);
  await assert.rejects(f.recovery.undo(result.undoToken), /subsequent edits/);
  assert.equal(await readFile(f.localFile, 'utf8'), next);
});

test('HTTP global recovery does not leak headers; malformed configuration stays visible through service inventory', async () => {
  const f = await fixture();
  await writeFile(f.globalFile, '[mcp_servers.demo]\nurl="https://example.invalid/mcp"\nhttp_headers={Authorization="fixture-private"}\n');
  const review = await f.recovery.preview(f.request);
  assert.ok(!JSON.stringify(review).includes('fixture-private'));
  const result = await f.recovery.apply(review.token);
  assert.equal((await f.inventory.list()).servers.find(row => row.name === 'demo').transport, 'http');
  const service = await createService({ repo: f.hub, uiDir: path.join(f.hub, 'ui'), mcpOptions: f.options });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const request = async (route, data) => fetch(`${service.origin}/api/${route}`, { method: data ? 'POST' : 'GET', headers, ...(data ? { body: JSON.stringify(data) } : {}) });
  let processChanges = 0;
  const proc = { write() { processChanges++; }, kill() { processChanges++; } };
  const active = service.sessions.make({ id: 'busy-recovery-fixture', agent: 'codex', cwd: f.root, projectId: f.project.id, repositoryId: 'primary', open: true });
  active.process = proc; active.activity = 'working'; service.sessions.items.set(active.id, active);
  try {
    await f.recovery.undo(result.undoToken);
    service.toolRefresh.launched(active, await service.toolRefresh.capture(active));
    const inventory = await (await request(`mcp?projectId=${f.project.id}&repositoryId=primary`)).json();
    assert.equal(inventory.recoveryCandidates.length, 1);
    const preview = await (await request('mcp/recovery/preview', f.request)).json();
    const applied = await request('mcp/recovery/apply', { token: preview.token });
    assert.equal(applied.status, 200);
    assert.equal(active.toolRefresh.status, 'pending');
    assert.equal(active.process, proc); assert.equal(processChanges, 0);
    assert.equal((await request('mcp/recovery/undo', { token: (await applied.json()).undoToken })).status, 200);
    await writeFile(f.localFile, '[broken');
    const malformed = await (await request(`mcp?projectId=${f.project.id}&repositoryId=primary`)).json();
    assert.ok(malformed.problems.length); assert.equal(malformed.recoveryCandidates.length, 0);
    assert.ok((await readdir(path.join(f.state, 'mcp-recovery-backups'))).length);
  } finally { active.process = null; service.sessions.items.clear(); await service.close(); }
});

test('review refuses relinked projects and linked local config folders', async () => {
  const f = await fixture();
  const review = await f.recovery.preview(f.request);
  const other = path.join(f.base, 'other'); await mkdir(other);
  await f.projects.save({ id: f.project.id, name: 'Fixture', repositoryPath: other });
  await assert.rejects(f.recovery.apply(review.token), /relinked/);
  await f.projects.save({ id: f.project.id, name: 'Fixture', repositoryPath: f.root });
  await rename(path.join(f.root, '.codex'), path.join(f.root, '.codex-saved'));
  await symlink(path.join(f.root, '.codex-saved'), path.join(f.root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.recovery.preview(f.request), /linked configuration folders/);
});

test('Claude recovery removes private local and project definitions while retaining auth and global configuration', async () => {
  const f = await fixture();
  const nativeFile = path.join(f.home, '.claude.json'), projectFile = path.join(f.root, '.mcp.json');
  const native = JSON.stringify({ oauthAccount: { fixture: 'private-auth' }, mcpServers: { demo: { type: 'http', url: 'https://example.invalid/mcp' } }, projects: { [f.root]: { mcpServers: { demo: { command: 'missing-claude-executable' }, other: { command: process.execPath } }, hasTrustDialogAccepted: true } } }, null, 2);
  const project = JSON.stringify({ mcpServers: { demo: { command: 'missing-project-executable' }, other: { command: process.execPath } } });
  await writeFile(nativeFile, native); await writeFile(projectFile, project);
  const request = { ...f.request, agent: 'claude' };
  assert.ok((await f.recovery.candidates(request, await f.inventory.list())).some(row => row.id === 'claude:demo'));
  const review = await f.recovery.preview(request);
  assert.equal(review.localFiles.length, 2); assert.ok(!JSON.stringify(review).includes('private-auth'));
  const applied = await f.recovery.apply(review.token);
  const result = JSON.parse(await readFile(nativeFile, 'utf8'));
  assert.deepEqual(result.oauthAccount, { fixture: 'private-auth' });
  assert.deepEqual(result.mcpServers, JSON.parse(native).mcpServers);
  assert.equal(result.projects[f.root].mcpServers.demo, undefined);
  assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).mcpServers.demo, undefined);
  await f.recovery.undo(applied.undoToken);
  assert.equal(await readFile(nativeFile, 'utf8'), native); assert.equal(await readFile(projectFile, 'utf8'), project);
  const disabled = JSON.parse(native); disabled.projects[f.root].disabledMcpServers = ['demo'];
  await writeFile(nativeFile, JSON.stringify(disabled));
  await assert.rejects(f.recovery.preview(request), /No attributable/);
});

for (const family of [1, 2]) test(`OpenCode V${family} recovery preserves JSONC comments and unrelated settings across project layers`, async () => {
  const f = await fixture(), globalRoot = path.join(f.home, '.config/opencode'); await mkdir(globalRoot, { recursive: true });
  const globalConfig = family === 1 ? { mcp: { demo: { type: 'remote', url: 'https://example.invalid/mcp', oauth: false } } } : { mcp: { servers: { demo: { type: 'remote', url: 'https://example.invalid/mcp', oauth: false } } } };
  await writeFile(path.join(globalRoot, 'opencode.json'), JSON.stringify(globalConfig));
  const localConfig = family === 1 ? { mcp: { demo: { type: 'local', command: ['missing-opencode-executable'] }, other: { type: 'local', command: [process.execPath] } }, model: 'fixture' } : { mcp: { servers: { demo: { type: 'local', command: ['missing-opencode-executable'] }, other: { type: 'local', command: [process.execPath] } } }, model: 'fixture' };
  const localFile = path.join(f.root, 'opencode.jsonc'), source = '// retained comment\n' + JSON.stringify(localConfig, null, 2);
  await writeFile(localFile, source);
  const request = { ...f.request, agent: 'opencode' }, review = await f.recovery.preview(request);
  const applied = await f.recovery.apply(review.token);
  const next = await readFile(localFile, 'utf8'); assert.ok(next.includes('// retained comment'));
  assert.equal((await f.inventory.list()).servers.find(row => row.id === 'opencode:demo').transport, 'http');
  await f.recovery.undo(applied.undoToken); assert.equal(await readFile(localFile, 'utf8'), source);
  f.recovery.env.OPENCODE_CONFIG_CONTENT = '{}';
  await assert.rejects(f.recovery.preview(request), /Custom\/runtime/);
});

test('multiple-file recovery rolls back the first write if the second file changes before replacement', async () => {
  const f = await fixture(), nativeFile = path.join(f.home, '.claude.json'), projectFile = path.join(f.root, '.mcp.json');
  const native = JSON.stringify({ mcpServers: { demo: { command: process.execPath } }, projects: { [f.root]: { mcpServers: { demo: { command: 'missing-fixture' } } } } });
  await writeFile(nativeFile, native); await writeFile(projectFile, '{"mcpServers":{"demo":{"command":"missing-fixture"}}}');
  const review = await f.recovery.preview({ ...f.request, agent: 'claude' });
  const originalReplace = f.recovery.replace.bind(f.recovery);
  let count = 0;
  f.recovery.replace = async (...args) => { if (++count === 2) await writeFile(projectFile, '{"changed":true}'); return originalReplace(...args); };
  await assert.rejects(f.recovery.apply(review.token), /Local configuration changed/);
  assert.equal(await readFile(nativeFile, 'utf8'), native);
  assert.equal(await readFile(projectFile, 'utf8'), '{"changed":true}');
});
