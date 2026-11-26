import { McpInventory } from './mcp.mjs';
import path from 'node:path';
import os from 'node:os';

// Native account stores retain credentials/history; tool definitions come from
// one platform configuration and are supplied explicitly at process launch.
export async function claudePlatformMcps(cwd, options) {
  const inventory = new McpInventory(cwd, options);
  try {
    const scan = await inventory.scan(), servers = {};
    const directory = path.resolve(options?.env?.CLAUDE_CONFIG_DIR || path.join(options?.home || os.homedir(), '.claude')).replaceAll('\\', '/').toLowerCase();
    if (scan.public.problems.some(problem => /(?:\.mcp\.json|\.claude\.json|managed-mcp\.json)$/i.test(problem.path) || path.resolve(problem.path).replaceAll('\\', '/').toLowerCase().startsWith(directory + '/'))) throw new Error('Claude MCP configuration could not be read. Repair it in Tools.');
    for (const { data, config } of scan.raw.values()) {
      if (data.client !== 'claude' || !data.enabled || data.name === 'mrmak_workspace' || data.name.startsWith('mr_mik_playwright_')) continue;
      const { enabled, disabled, ...definition } = config; void enabled; void disabled;
      servers[data.name] = definition;
    }
    return servers;
  } finally { inventory.close(); }
}
