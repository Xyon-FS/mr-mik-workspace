import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { SharedBrowsers } from '../shared-browser.mjs';
import { compactBrowserResult, inlineBrowserObservation } from '../browser-results.mjs';

test('automatic snapshot previews are bounded, compare complete content and never inline files outside the owned output folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-browser-observation-'));
  const folder = await mkdtemp(path.join(root, 'owned-')), file = path.join(folder, 'page.yml'), outside = path.join(root, 'outside.yml');
  const record = { folder };
  const make = target => ({ content: [{ type: 'text', text: `### Snapshot\n- [Snapshot](${target})` }] });
  await writeFile(file, '- entry\n'.repeat(3000) + '- original tail');
  const first = compactBrowserResult(record, 'browser_click', await inlineBrowserObservation(record, 'browser_click', make(file)));
  assert.match(first.content[0].text, /preview shortened/); assert.ok(first.content[0].text.length < 13000);
  const duplicate = compactBrowserResult(record, 'browser_click', await inlineBrowserObservation(record, 'browser_click', make(file)));
  assert.match(duplicate.content[0].text, /Unchanged from/);
  await writeFile(file, '- entry\n'.repeat(3000) + '- changed tail');
  const changed = compactBrowserResult(record, 'browser_click', await inlineBrowserObservation(record, 'browser_click', make(file)));
  assert.doesNotMatch(changed.content[0].text, /Unchanged from/);
  await writeFile(outside, 'Must not inline');
  assert.deepEqual(await inlineBrowserObservation(record, 'browser_click', make(outside)), make(outside));
  assert.deepEqual(await inlineBrowserObservation(record, 'browser_snapshot', make(file)), make(file));
});

test('browser results compact only successful duplicate observations; explicit snapshots, changes and errors remain visible', () => {
  const record = {};
  const result = { content: [{ type: 'text', text: '### Ran Playwright code\n```js\nawait page.click();\n```\n### Page\nURL: https://example.com\n### Snapshot\n- button "Next" [ref=e1]\n' }, { type: 'image', data: 'fixture', mimeType: 'image/png' }] };
  const first = compactBrowserResult(record, 'browser_click', result);
  assert.match(first.content[0].text, /ref=e1/); assert.doesNotMatch(first.content[0].text, /Ran Playwright code/);
  const duplicate = compactBrowserResult(record, 'browser_click', result);
  assert.match(duplicate.content[0].text, /Unchanged from/); assert.match(duplicate.content[0].text, /URL:/);
  assert.equal(duplicate.content[1], result.content[1]);
  assert.match(compactBrowserResult(record, 'browser_snapshot', result).content[0].text, /ref=e1/);
  const changed = { content: [{ type: 'text', text: result.content[0].text.replace('ref=e1', 'ref=e2') }] };
  assert.match(compactBrowserResult(record, 'browser_click', changed).content[0].text, /ref=e2/);
  const error = { ...result, isError: true }; assert.equal(compactBrowserResult(record, 'browser_click', error), error);
  assert.match(compactBrowserResult(record, 'browser_click', changed).content[0].text, /ref=e2/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-shared-boundary-'));
  const session = { id: 'fixture-chat', agent: 'codex', chatInterface: 'chat', process: {}, cwd: root, graphical: { previewPaths: new Set() } };
  const manager = new SharedBrowsers({ stateDir: root, session: id => id === session.id ? session : null }); manager.origin = 'http://127.0.0.1:12345';
  const definition = manager.prepare(session, 'msedge'), record = manager.get(session.id);
  return { manager, record, definition, root, session };
}

test('shared proxy capabilities stay in child environment and are scoped to a live graphical chat', async () => {
  const { manager, record, definition, session } = await fixture();
  try {
    assert.equal(definition.env.MRMIK_BROWSER_TOKEN, record.token);
    assert.ok(!definition.args.join(' ').includes(record.token));
    assert.throws(() => manager.authenticate('wrong'), /expired/);
    assert.equal(manager.authenticate(record.token), record);
    session.process = null; assert.throws(() => manager.authenticate(record.token), /unavailable/);
    assert.equal(record.browser, undefined);
  } finally { await manager.close(); }
});

test('shared host constrains output paths, requires explicit upload scope and excludes host execution', async () => {
  const { manager, record, root, session } = await fixture();
  try {
    const calls = []; record.context = {}; record.status = 'ready'; record.folder = root;
    // The synthetic owned root is also tracked by the fixture cleanup hook.
    record.folderInfo = await (await import('node:fs/promises')).lstat(root);
    record.client = { callTool: async request => { calls.push(request); if (request.name === 'browser_take_screenshot') await writeFile(request.arguments.filename, Buffer.from('synthetic screenshot')); return { content: [] }; }, close: async () => {} };
    const screenshot = await manager.call(record, 'browser_take_screenshot', { filename: 'C:/outside/private.png' });
    assert.equal(path.dirname(calls[0].arguments.filename), root);
    assert.match(path.basename(calls[0].arguments.filename), /^[a-f0-9-]+\.png$/);
    assert.equal(screenshot.content.find(part => part.type === 'image').data, Buffer.from('synthetic screenshot').toString('base64'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'mik-shared-upload-'));
    const file = path.join(outside, 'fixture.txt'); await writeFile(file, 'Synthetic');
    await assert.rejects(manager.checkedUpload(record, file), /Attach/);
    session.graphical.previewPaths.add(file); assert.equal(await manager.checkedUpload(record, file), file);
    const auth = path.join(root, 'auth.json'); await writeFile(auth, '{}'); await assert.rejects(manager.checkedUpload(record, auth), /non-sensitive/);
    await assert.rejects(manager.call(record, 'browser_run_code', {}), /unavailable/);
    await assert.rejects(manager.call(record, 'browser_navigate', { url: 'file:///C:/private.txt' }), /HTTP/);
    record.owner = 'user'; await assert.rejects(manager.call(record, 'browser_snapshot', {}), /user controls/);
    assert.equal(calls.length, 1, 'Rejected tools must never reach the MCP backend');
  } finally { await manager.close(); }
});

test('uncertain transport stops only its browser; concurrent teardown waits for owned transfers', async () => {
  const { manager, record } = await fixture(); let releaseBrowser, releaseTransfer;
  try {
    let closes = 0;
    const browserStopped = new Promise(resolve => { releaseBrowser = resolve; });
    const transfer = new Promise(resolve => { releaseTransfer = resolve; }); record.transfers.add(transfer);
    record.browser = { close: async () => { closes++; await browserStopped; } };
    record.client = { callTool: async () => { throw new Error('Private diagnostic must not escape'); }, close: async () => {} };
    const invocation = manager.invoke(record, 'browser_snapshot', {});
    const rejected = assert.rejects(invocation, /shared browser stopped/);
    const stopped = manager.stopRuntime(record); releaseBrowser();
    let finished = false; void stopped.then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    releaseTransfer(); await Promise.all([rejected, stopped]); assert.equal(closes, 1); assert.equal(record.status, 'failed');
    assert.equal(record.client, null);
  } finally { releaseBrowser?.(); releaseTransfer?.(); await manager.close(); }
});
