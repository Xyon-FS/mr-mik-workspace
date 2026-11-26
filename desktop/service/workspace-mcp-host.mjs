// Private launch descriptor only. Never print configuration or child stderr.
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';

try {
  const [file, name] = process.argv.slice(2), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 ** 2) throw new Error('Invalid descriptor');
  const entry = JSON.parse(await readFile(file, 'utf8')).servers?.[name];
  if (!entry || typeof entry.cwd !== 'string') throw new Error('Unknown server');
  {
    const client = new Client({ name: 'mr-mik-linked-project', version: '1' }, { capabilities: { roots: { listChanged: false }, elicitation: {}, sampling: {} } });
    let host;
    client.fallbackRequestHandler = async (request, extra) => {
      if (request.method === 'roots/list') return { roots: [{ uri: pathToFileURL(entry.cwd).href, name: 'Linked project' }] };
      if (!host) throw new Error('Linked client not ready');
      return host.request({ method: request.method, params: request.params }, ResultSchema, { signal: extra.signal });
    };
    const transport = entry.transport === 'stdio' ? new StdioClientTransport({ command: entry.command, args: entry.args, cwd: entry.cwd, env: { ...entry.env, CLAUDE_PROJECT_DIR: entry.cwd }, stderr: 'ignore' })
      : entry.transport === 'sse' ? new SSEClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: entry.headers }) } })
        : new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } });
    await client.connect(transport);
    const capabilities = client.getServerCapabilities() || {};
    // Forward native operations, including resources/prompts and elicitations;
    // the outer agent remains the approval owner for each tool call.
    host = new Server({ name: 'mr-mik-linked-project', version: '1' }, { capabilities, instructions: client.getInstructions() });
    host.fallbackRequestHandler = (request, extra) => client.request({ method: request.method, params: request.params }, ResultSchema, { signal: extra.signal });
    client.fallbackNotificationHandler = notification => host.notification(notification);
    host.fallbackNotificationHandler = notification => client.notification(notification);
    let closing;
    const close = () => closing ||= Promise.allSettled([client.close(), host.close()]).then(() => {});
    client.onclose = () => { void close(); };
    process.stdin.on('end', () => { void close(); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void close().finally(() => process.exit()); });
    await host.connect(new StdioServerTransport());
  }
} catch { process.stderr.write('Linked project MCP could not start. Check its source in Tools.\n'); process.exitCode = 1; }
