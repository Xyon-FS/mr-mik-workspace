// Synthetic MCP process used only by isolated acceptance checks.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (message.id == null) return;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-linked-project', version: '1' } };
  if (message.method === 'tools/list') {
    appendFileSync(process.argv[2], JSON.stringify({ kind: 'list', cwd: process.cwd() }) + '\n');
    result = { tools: [{ name: 'synthetic_unity_visibility', description: 'Synthetic visibility fixture; no Unity connection.', inputSchema: { type: 'object', properties: {} } }] };
  }
  if (message.method === 'tools/call') { appendFileSync(process.argv[2], 'CALL\n'); result = { content: [{ type: 'text', text: 'Synthetic result' }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
