import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BrowserToolCatalog} from '../browser-tool-catalog.mjs';
import {SharedBrowsers} from '../shared-browser.mjs';
import {mkdtemp} from './fixtures.mjs';
import os from 'node:os';
import path from 'node:path';

const value = {tools: [{name: 'browser_snapshot', inputSchema: {type: 'object', properties: {}}}]};
class FakeWorker extends EventEmitter {
  async terminate() { this.emit('exit', 1); }
}
test('catalog discovery retries failed workers, shares the retry and caches only after exit', async () => {
  const workers = [];
  const catalog = new BrowserToolCatalog({createWorker: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }});
  try {
    const first = catalog.get();
    workers[0].emit('error', new Error('private native details'));
    workers[0].emit('exit', 1);
    await assert.rejects(first, error => /could not be loaded/.test(error.message) && !error.message.includes('private'));
    const retry = catalog.get();
    assert.equal(catalog.get(), retry);
    assert.equal(workers.length, 2);
    let settled = false;
    retry.then(() => { settled = true; });
    workers[1].emit('message', value);
    await Promise.resolve();
    assert.equal(settled, false);
    workers[1].emit('exit', 0);
    assert.deepEqual(await retry, value);
    assert.equal(catalog.get(), retry);
  } finally { await catalog.close(); }
});
test('installed worker returns exactly the native schemas and Off discovery cannot launch a browser', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-catalog-'));
  const manager = new SharedBrowsers({stateDir: root, profileRoot: root, hub: root, session: () => null, launch: () => { throw new Error('Unexpected browser launch'); }});
  const catalog = new BrowserToolCatalog();
  try {
    const actual = await catalog.get();
    const {createConnection} = await import('@playwright/mcp');
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const {InMemoryTransport} = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = await createConnection({}, async () => { throw new Error('No browser for discovery'); });
    const client = new Client({name: 'mr-mik-browser-catalog', version: '1'});
    try {
      const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
      assert.deepEqual(actual, await client.listTools());
    } finally { await client.close(); await server.close(); }
    const filtered = await manager.tools();
    assert.ok(filtered.tools.some(tool => tool.name === 'browser_find'));
    assert.ok(!filtered.tools.some(tool => /run_code|install/.test(tool.name)));
    assert.equal(manager.records.size, 0);
  } finally { await catalog.close(); await manager.close(); }
});
