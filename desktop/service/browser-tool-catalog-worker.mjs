// Schema discovery only. Heavy Playwright module loading stays off the host loop.
import { parentPort } from 'node:worker_threads';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const server = await createConnection({}, async () => { throw new Error('Discovery does not launch a browser.'); });
const client = new Client({ name: 'mr-mik-browser-catalog', version: '1' });
let catalog;
try {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  catalog = await client.listTools();
} finally {
  try { await client.close(); } finally { await server.close(); }
}
// Only publish success after both transports have closed.
parentPort.postMessage({ tools: catalog.tools }); parentPort.close();
