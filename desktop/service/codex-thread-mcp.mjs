import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, unlink, rmdir, lstat } from 'node:fs/promises';
import { realProfileDirectory } from './codex-profile-layout.mjs';

const entry = fileURLToPath(new URL('./codex-thread-mcp-entry.mjs', import.meta.url));
const bridgeScript = fileURLToPath(new URL('./bridge-mcp.mjs', import.meta.url));
const browserScript = fileURLToPath(new URL('./shared-browser-entry.mjs', import.meta.url));
const namePattern = /^[a-zA-Z0-9_-]+$/;

// Descriptors are private runtime files, not native config/argv credentials.
export async function codexThreadMcp({ stateDir, bridge, browser }) {
  if (!stateDir || bridge && bridge.script !== bridgeScript || browser && (!browser.shared || browser.command !== process.execPath || browser.args?.length !== 1 || browser.args[0] !== browserScript)) return null;
  if (Object.keys(bridge?.linkedMcps || {}).some(name => !namePattern.test(name)) || browser && !namePattern.test(browser.serverName)) return null;
  const folder = await realProfileDirectory(path.join(stateDir, 'codex-thread-mcp'), true);
  const directory = await mkdtemp(path.join(folder, 'scope-'));
  const original = await lstat(directory);
  const files = [], config = {};
  const cleanup = async () => {
    const current = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!current) return;
    if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== original.ino || await realProfileDirectory(directory) !== directory) throw new Error('Scoped MCP cleanup refused a replaced runtime directory.');
    for (const file of files) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
  const define = async (name, kind, env) => {
    const file = path.join(directory, `${kind}.json`);
    await writeFile(file, JSON.stringify({ version: 1, kind, env }), { flag: 'wx', mode: 0o600 }); files.push(file);
    config[`mcp_servers.${name}`] = { command: process.execPath, args: [entry, file], enabled: true };
  };
  try {
    if (bridge) await define('mrmak_workspace', 'bridge', { MRMAK_BRIDGE_URL: bridge.url, MRMAK_BRIDGE_TOKEN: bridge.token });
    for (const [name, value] of Object.entries(bridge?.linkedMcps || {})) config[`mcp_servers.${name}`] = value;
    if (bridge?.codexWritableRoots) config['sandbox_workspace_write.writable_roots'] = bridge.contentDirectories || [];
    if (browser) await define(browser.serverName, 'browser', browser.env);
    return { config, developerInstructions: bridge?.instructions || undefined, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
