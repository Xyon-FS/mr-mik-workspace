import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { mkdtemp } from './fixtures.mjs';
import { claudePlatformMcps } from '../claude-platform-mcps.mjs';
import { WorkspaceMcpLaunches } from '../workspace-mcps.mjs';
import { terminalCommand } from '../agents.mjs';

test('Claude account launches receive common MCP definitions without credentials in argv or copied account stores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-platform-tools-')), home = path.join(root, 'home'), cwd = path.join(root, 'work');
  await mkdir(home); await mkdir(cwd);
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'fixture-secret' } } } }));
  const appData = path.join(root, 'appdata');
  const cli = path.join(appData, 'npm/node_modules/@anthropic-ai/claude-code/cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, 'throw new Error("Command fixture must never be executed");\n');
  const env = { APPDATA: appData, PATH: root };
  if (process.platform === 'win32') env.LOCALAPPDATA = root;
  const servers = await claudePlatformMcps(cwd, { home, env }); assert.equal(servers.shared.headers.Authorization, 'fixture-secret');
  const launches = new WorkspaceMcpLaunches(root), session = { id: 'synthetic-account', agent: 'claude' };
  try {
    const file = await launches.claudePlatform(session, servers);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers, servers);
    const command = terminalCommand('claude', { env, cwd, bridge: { claudeMcpFile: file, script: 'synthetic-bridge.mjs' } });
    assert.ok(command.args.includes('--strict-mcp-config')); assert.ok(command.args.includes(file));
    assert.equal(command.args.filter(value => value === '--mcp-config').length, 1);
    assert.ok(!command.args.join(' ').includes('fixture-secret'));
    await launches.release(session.id); assert.equal(await lstat(file).catch(() => null), null);
  } finally { await launches.close(); }
});
