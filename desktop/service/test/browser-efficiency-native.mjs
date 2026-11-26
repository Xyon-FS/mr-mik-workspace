import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
import { SharedBrowsers } from '../shared-browser.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-efficiency-'));
const session = { id: 'fixture', agent: 'codex', chatInterface: 'chat', process: {}, graphical: { previewPaths: new Set() } };
const manager = new SharedBrowsers({ stateDir: root, profileRoot: path.join(root, 'profiles'), hub: root, session: () => session });
const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<html><title>Efficiency fixture</title><h1>Small fixture</h1><button id="apply">Apply settings</button><p>Stable result</p></html>'); });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  manager.origin = 'http://127.0.0.1:1';
  manager.prepare(session, 'msedge', { temporary: true });
  const record = manager.get(session.id);
  const tools = (await manager.tools()).tools;
  assert.ok(tools.some(tool => tool.name === 'browser_find'));
  assert.ok(!tools.some(tool => /run_code|install/.test(tool.name)));
  const text = result => result.content.filter(value => value.type === 'text').map(value => value.text).join('\n');
  const navigate = await manager.call(record, 'browser_navigate', { url: `http://127.0.0.1:${server.address().port}` });
  assert.ok(!navigate.isError, text(navigate)); assert.match(text(navigate), /Small fixture/);
  assert.doesNotMatch(text(navigate), /### Ran Playwright code/);
  const found = await manager.call(record, 'browser_find', { text: 'Apply settings' });
  assert.ok(!found.isError, text(found)); assert.match(text(found), /Apply settings/);
  const observed = await manager.call(record, 'browser_snapshot'); assert.match(text(observed), /Stable result/);
  const observedAgain = await manager.call(record, 'browser_snapshot'); assert.match(text(observedAgain), /Stable result/);
  assert.doesNotMatch(text(observedAgain), /Unchanged from/);
  await manager.call(record, 'browser_wait_for', { time: 0.01 });
  const automaticAgain = await manager.call(record, 'browser_wait_for', { time: 0.01 });
  assert.match(text(automaticAgain), /Unchanged from/);
  const result = await manager.call(record, 'browser_evaluate', { function: '() => ({ title: document.title, count: document.querySelectorAll("button").length })' });
  assert.match(text(result), /Efficiency fixture/); assert.match(text(result), /count/);
  await manager.action(record, { action: 'owner', owner: 'user' });
  assert.equal(record.lastSnapshot, null);
  await assert.rejects(manager.call(record, 'browser_find', { text: 'Apply' }), /user controls/);
  console.log('Browser efficiency native check passed: targeted lookup, full explicit snapshots, result preservation and manual ownership. No model calls.');
} finally {
  await manager.close(); await new Promise(resolve => server.close(resolve)); await cleanupFixtures();
}
