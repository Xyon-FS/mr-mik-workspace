import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { mkdtemp, createService, testBrowserEnvironment } from './fixtures.mjs';

test('browser-only switches retain website state across presentation changes and isolate temporary mode', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-persistence-'));
  const repo = path.join(root, 'hub'); await mkdir(path.join(repo, 'workspace'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const launches = [];
  let failLaunch = false;
  const service = await createService({ repo, mcpOptions: { home: path.join(root, 'home'), env: {} }, browserOptions: {
    launch: options => chromium.launch({ ...options, env: testBrowserEnvironment(), headless: true }),
    launchPersistent: (folder, options) => {
      launches.push({ folder, headless: options.headless });
      if (failLaunch) throw new Error('Synthetic launch failure');
      // Exercise external launch selection/lifecycle without displaying a test
      // window on the user's desktop. Native window appearance is manual QA.
      return chromium.launchPersistentContext(folder, { ...options, env: testBrowserEnvironment(), headless: true });
    },
  } });
  const session = service.sessions.make({ id: 'persistent-fixture', projectId: null, cwd: repo, agent: 'codex', chatInterface: 'chat' });
  session.process = {}; service.sessions.items.set(session.id, session);
  const manager = service.sharedBrowsers;
  try {
    const channel = process.env.MRMIK_TEST_BROWSER_CHANNEL === 'chrome' ? 'chrome' : 'msedge';
    await service.browserSettings.change({ scope: 'chat', sessionId: session.id, choice: channel });
    service.sessions.prepareBrowser(session); let record = manager.get(session.id);
    await manager.action(record, { action: 'connect' });
    const fixture = path.join(repo, 'fixture.html'); await writeFile(fixture, '<title>Local fixture</title><h1>Persistence</h1>');
    const url = service.files.url(fixture);
    await manager.call(record, 'browser_navigate', { url });
    await record.context.addCookies([{ name: 'synthetic-proof', value: 'retained', url, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await record.context.pages()[0].evaluate(() => localStorage.setItem('synthetic-proof', 'retained'));
    const originalContext = record.context;
    let release;
    const manual = manager.run(record, 'agent', () => new Promise(resolve => { release = resolve; }));
    await service.browserSettings.change({ scope: 'chat', sessionId: session.id, presentation: 'external' });
    assert.equal(record.context, originalContext); assert.equal(record.pendingConfig.presentation, 'external');
    release(); await manual;
    assert.notEqual(record.context, originalContext); assert.equal(launches.at(-1).headless, false);
    assert.ok((await record.context.cookies()).some(cookie => cookie.name === 'synthetic-proof'));
    await manager.call(record, 'browser_navigate', { url });
    assert.equal(await record.context.pages()[0].evaluate(() => localStorage.getItem('synthetic-proof')), 'retained');
    await service.browserSettings.change({ scope: 'chat', sessionId: session.id, temporary: true });
    assert.ok(!(await record.context.cookies()).some(cookie => cookie.name === 'synthetic-proof'));
    await service.browserSettings.change({ scope: 'chat', sessionId: session.id, temporary: false, presentation: 'workspace' });
    assert.equal(launches.at(-1).headless, true);
    assert.ok((await record.context.cookies()).some(cookie => cookie.name === 'synthetic-proof'));
    manager.release(session.id); await Promise.all([...manager.closing]);
    service.sessions.prepareBrowser(session); record = manager.get(session.id);
    await manager.action(record, { action: 'connect' });
    assert.ok((await record.context.cookies()).some(cookie => cookie.name === 'synthetic-proof'), 'Closing chat keeps disk state');
    await manager.clearProfile(record);
    await manager.action(record, { action: 'connect' });
    assert.ok(!(await record.context.cookies()).some(cookie => cookie.name === 'synthetic-proof'));
    assert.equal(session.process != null, true);

    failLaunch = true;
    let finish, actions = 0;
    const action = manager.run(record, 'agent', async () => {
      actions++;
      await new Promise(resolve => { finish = resolve; });
      return 'completed once';
    });
    try {
      await service.browserSettings.change({ scope: 'chat', sessionId: session.id, presentation: 'external' });
      finish();
      assert.equal(await action, 'completed once');
      assert.equal(actions, 1);
      assert.equal(record.status, 'failed');
      assert.doesNotMatch(record.error, /Synthetic/);
    } finally { finish?.(); await action; }
  } finally { session.process = null; service.sessions.items.clear(); await service.close(); }
});
