import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { McpInventory } from './mcp.mjs';

export async function mcpPreflight(folders, options) {
  if (!Array.isArray(folders) || folders.length > 32 || folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder))) throw new Error('Choose up to 32 absolute linked project folders.');
  const reports = [];
  for (const folder of [...new Set(folders)]) {
    let inventory;
    try {
      const root = await realpath(folder);
      if (!(await stat(root)).isDirectory()) throw new Error('Not a folder');
      inventory = new McpInventory(root, options);
      const result = await inventory.list();
      reports.push({ folder, problems: result.problems, tools: result.servers.filter(server => ['codex', 'claude', 'opencode'].includes(server.client) && ['invalid-config', 'missing-command', 'missing-env'].includes(server.readiness)).map(server => ({ agent: server.client, name: server.name, status: server.readiness, message: server.configurationIssue || (server.readiness === 'missing-command' ? 'Executable not found on this PC.' : server.readiness === 'missing-env' ? 'Required environment values are missing.' : 'Local transport configuration is invalid.') })) });
    } catch { reports.push({ folder, problems: [{ path: folder, message: 'This folder or its configuration could not be inspected safely.' }], tools: [] }); }
    finally { inventory?.close(); }
  }
  return { reports, note: 'Configuration inspection only; no MCP connection or tool was started. Warnings do not block import or relinking. Review affected entries in Tools after selecting the linked project.' };
}
