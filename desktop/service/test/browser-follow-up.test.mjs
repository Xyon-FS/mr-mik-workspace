import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { mkdtemp, createService } from './fixtures.mjs';
import { BrowserProfiles } from '../browser-profiles.mjs';
import { unzipSync, strFromU8 } from 'fflate';

test('profile isolation, exclusive leases, persistent data and targeted clear', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-profile-'));
  const profiles = new BrowserProfiles(path.join(root, 'profiles'), 'synthetic-hub');
  const a = { id: 'a', projectId: 'one' };
  const lease = await profiles.acquire(a, 'msedge');
  try {
    await writeFile(path.join(lease.folder, 'synthetic-storage'), 'retained');
    await assert.rejects(profiles.acquire(a, 'msedge'), /in use/);
    await assert.rejects(profiles.clear(a, 'msedge'), /in use/);
    for (const [session, channel] of [[{ ...a, id: 'b' }, 'msedge'], [{ ...a, projectId: 'two' }, 'msedge'], [a, 'chrome']]) {
      const other = await profiles.acquire(session, channel);
      try { assert.notEqual(other.folder, lease.folder); } finally { await other.release(); }
    }
    const otherHub = new BrowserProfiles(path.join(root, 'profiles'), 'another-hub');
    assert.notEqual((await otherHub.location(a, 'msedge')).folder, lease.folder);
  } finally { await lease.release(); }
  const reopened = await profiles.acquire(a, 'msedge');
  try { assert.equal(await readFile(path.join(reopened.folder, 'synthetic-storage'), 'utf8'), 'retained'); } finally { await reopened.release(); }
  await profiles.clear(a, 'msedge');
  assert.equal(await lstat(lease.folder).catch(() => null), null);
});

test('UI and Bridge share browser defaults and chat overrides without changing CLI processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-settings-'));
  const repo = path.join(root, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const nativeHome = path.join(root, 'home');
  const service = await createService({ repo, mcpOptions: { home: nativeHome, env: {} } });
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const post = async data => {
    const response = await fetch(`${service.origin}/api/browser-settings`, { method: 'POST', headers, body: JSON.stringify(data) });
    return { response, data: await response.json() };
  };
  let writes = 0;
  const session = service.sessions.make({ id: 'graphical-fixture', agent: 'codex', chatInterface: 'chat', cwd: repo });
  const cli = service.sessions.make({ id: 'cli-fixture', agent: 'codex', chatInterface: 'cli', cwd: repo });
  const proc = { write: () => { writes++; }, kill: () => { writes++; } };
  session.process = proc; cli.process = proc;
  service.sessions.items.set(session.id, session); service.sessions.items.set(cli.id, cli);
  const token = service.bridge.issue(session.id, null);
  try {
    assert.equal(service.sessions.prepareBrowser(cli), null);
    const legacyResult = await fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ managedBrowser: 'msedge', managedBrowserHeadless: true }) });
    assert.equal(legacyResult.status, 200);
    assert.equal(writes, 0);
    assert.equal(cli.process, proc);
    const browser = service.sessions.prepareBrowser(cli);
    assert.equal(browser.args[browser.args.indexOf('--browser') + 1], 'msedge');
    assert.ok(browser.args.includes('--headless'));
    assert.match(browser.args[browser.args.indexOf('--output-dir') + 1], /browser-output/);
    assert.equal(service.sessions.prepareBrowser({ ...cli, agent: 'shell' }), null);
    const launch = await service.sessions.prepareLaunch(cli, { preview: true });
    assert.match(launch.instructions, /Mr. Mik provides mr_mik_playwright/);
    const invalid = await fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ managedBrowser: 'personal', managedBrowserHeadless: false }) });
    assert.notEqual(invalid.status, 200);
    assert.ok(service.sessions.prepareBrowser(cli).args.includes('--headless'));
    const legacySaved = JSON.parse(await readFile(path.join(repo, '.mrmak/settings.json'), 'utf8'));
    assert.equal(legacySaved.managedBrowser, 'msedge');
    assert.equal(legacySaved.managedBrowserHeadless, true);
    const legacyProject = await service.projects.save({ name: 'Browser project' });
    const otherProject = await service.projects.save({ name: 'Other project' });
    const projectSession = { ...cli, projectId: legacyProject.id, repositoryId: null, cwd: path.join(repo, '.mrmak', 'project-chats', legacyProject.id) };
    const updateProject = choice => fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ managedBrowserProject: { projectId: legacyProject.id, choice } }) });
    assert.equal((await updateProject('off')).status, 200);
    assert.equal(service.sessions.prepareBrowser(projectSession), null);
    assert.ok(service.sessions.prepareBrowser({ ...cli, projectId: otherProject.id }));
    assert.equal((await updateProject('chrome')).status, 200);
    const projectBrowser = service.sessions.prepareBrowser(projectSession);
    assert.equal(projectBrowser.args[projectBrowser.args.indexOf('--browser') + 1], 'chrome');
    assert.equal(JSON.parse(await readFile(path.join(repo, '.mrmak/settings.json'), 'utf8')).managedBrowserProjects[legacyProject.id], 'chrome');
    assert.notEqual((await updateProject('personal')).status, 200);
    assert.equal((await updateProject(null)).status, 200);
    const inheritedBrowser = service.sessions.prepareBrowser(projectSession);
    assert.equal(inheritedBrowser.args[inheritedBrowser.args.indexOf('--browser') + 1], 'msedge');
    assert.equal(writes, 0);
    assert.equal(cli.process, proc);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(path.join(nativeHome, '.codex/config.toml')), false);
    assert.equal((await fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ managedBrowser: 'off', managedBrowserHeadless: false }) })).status, 200);
    service.sessions.prepareBrowser(session);
    assert.equal((await service.sharedBrowsers.tools()).tools.some(tool => tool.name === 'browser_navigate'), true);
    assert.equal(service.sharedBrowsers.get(session.id).browser, undefined);
    const initial = await service.bridge.call(token, 'mrmak_tool_settings', { section: 'browser' });
    assert.equal(initial.browser.effective.presentation, 'workspace');
    await service.bridge.call(token, 'mrmak_manage_tool', { action: 'browser', choice: 'msedge', presentation: 'external', confirmed: true });
    let result = await fetch(`${service.origin}/api/browser-settings?sessionId=${session.id}`, { headers }).then(response => response.json());
    assert.equal(result.chat.presentation, 'external'); assert.equal(result.global.presentation, 'workspace');
    const project = await service.projects.save({ name: 'Synthetic browser project' }); session.projectId = project.id;
    const projectToken = service.bridge.issue(session.id, project.id);
    await service.bridge.call(projectToken, 'mrmak_manage_tool', { action: 'browser', scope: 'project', presentation: 'external', confirmed: true });
    await post({ scope: 'chat', sessionId: session.id, presentation: null });
    result = await service.bridge.call(projectToken, 'mrmak_tool_settings', { section: 'browser' });
    assert.equal(result.browser.project.presentation, 'external'); assert.equal(result.browser.desired.presentation, 'external');
    assert.equal((await post({ scope: 'global', presentation: 'invalid' })).response.ok, false);
    assert.equal((await post({ scope: 'global', presentation: null })).response.ok, false);
    const record = service.sharedBrowsers.get(session.id); record.owner = 'user';
    await post({ scope: 'chat', sessionId: session.id, temporary: true });
    assert.equal(record.pendingConfig.temporary, true); assert.equal(record.temporary, false);
    await service.sharedBrowsers.action(record, { action: 'owner', owner: 'agent' });
    assert.equal(record.temporary, true); assert.equal(record.pendingConfig, null);
    record.owner = 'user'; service.nativeMessage({ type: 'workspace-hidden' });
    assert.equal(record.owner, 'agent'); assert.equal(record.browser, null);
    assert.equal(service.sessions.prepareBrowser(cli), null);
    assert.equal(writes, 0); assert.equal(session.process, proc); assert.equal(cli.process, proc);
    const saved = JSON.parse(await readFile(path.join(repo, '.mrmak/settings.json'), 'utf8'));
    assert.equal(saved.managedBrowserChats[session.id].temporary, true);
    assert.ok(!JSON.stringify(result.browser).includes(path.join(root, 'home')));
    await assert.rejects(service.bridge.call(projectToken, 'mrmak_manage_tool', { action: 'browser-clear', scope: 'project', confirmed: true }), /current chat/);
    session.process = null; cli.process = null; service.sessions.items.clear();
    assert.equal((await fetch(`${service.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ managedBrowser: 'msedge', managedBrowserHeadless: true }) })).status, 200);
    assert.equal((await updateProject('chrome')).status, 200);
    const destination = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-export-'));
    const exported = await fetch(`${service.origin}/api/workspace/export`, { method: 'POST', headers, body: JSON.stringify({ folder: destination, chats: 'light' }) });
    assert.equal(exported.status, 201);
    const archive = unzipSync(await readFile((await exported.json()).path));
    const portableSettings = JSON.parse(strFromU8(archive['state/settings.json']));
    assert.equal('managedBrowser' in portableSettings, false);
    assert.equal('managedBrowserHeadless' in portableSettings, false);
    assert.equal('managedBrowserProjects' in portableSettings, false);
    assert.equal('managedBrowserChats' in portableSettings, false);
  } finally { session.process = null; cli.process = null; service.sessions.items.clear(); await service.close(); }
});
