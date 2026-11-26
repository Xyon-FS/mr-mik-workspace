// Native discovery only: no authentication, user prompts or model requests.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, cleanupFixtures } from './fixtures.mjs';
const index = process.argv.indexOf('--portable');
const serviceRoot = index < 0 ? fileURLToPath(new URL('../', import.meta.url)) : path.resolve(process.argv[index + 1], 'App/runtime/service');
const { resolveWorkspaceMcps, WorkspaceMcpLaunches } = await import(pathToFileURL(path.join(serviceRoot, 'workspace-mcps.mjs')));
const { ClaudeChat } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat.mjs')));
const { claudeChatTransport } = await import(pathToFileURL(path.join(serviceRoot, 'claude-chat-transport.mjs')));
const { CodexChat } = await import(pathToFileURL(path.join(serviceRoot, 'codex-chat.mjs')));

if (!process.argv.includes('--run')) throw new Error('Pass --run for native MCP discovery.');
let claude, codex, transport, launches;
try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mik-workspace-mcp-native-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) { env[key] = path.join(root, key); await mkdir(env[key]); }
  Object.assign(env, { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1' });
  const main = path.join(root, 'main'), child = path.join(root, 'unity'), receipt = path.join(root, 'receipt.txt'); await mkdir(main); await mkdir(child); await mkdir(path.join(child, '.codex'));
  const script = fileURLToPath(new URL('./workspace-mcp-fixture.mjs', import.meta.url));
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [child]: { mcpServers: { UnityMCP: { type: 'stdio', command: process.execPath, args: [script, receipt] } } } } }));
  await writeFile(path.join(env.CODEX_HOME, 'config.toml'), `check_for_update_on_startup=false\nweb_search="disabled"\n[features]\napps=false\n[projects.${JSON.stringify(child)}]\ntrust_level="trusted"\n[mcp_servers.UnityMCP]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([script, receipt])}\nenabled=false\n`);
  await writeFile(path.join(child, '.codex/config.toml'), '[mcp_servers.UnityMCP]\nenabled=true\n');
  const project = { id: 'fixture', repositories: [{ id: 'primary', name: 'Main', available: true }, { id: 'unity', name: 'Unity', available: true }] };
  const projects = { get: async () => project, root: async (_, id) => id === 'unity' ? child : main };
  launches = new WorkspaceMcpLaunches(path.join(root, 'state'));
  for (const agent of ['claude', 'codex']) {
    const session = { id: randomUUID(), nativeId: agent === 'claude' ? randomUUID() : null, agent, chatInterface: 'chat', cwd: main, projectId: 'fixture', repositoryId: 'primary', effort: 'low', codexPermissions: 'ask' };
    const resolved = await resolveWorkspaceMcps(projects, session, { home: env.HOME, env });
    assert.equal(resolved.origins.length, 1);
    const linkedMcps = await launches.prepare(session, resolved), alias = resolved.origins[0].name;
    const bridge = { linkedMcps };
    if (agent === 'claude') {
      transport = claudeChatTransport({ session, env, bridge });
      claude = new ClaudeChat({ session, env, bridge, stateDir: path.join(root, 'state'), transportFactory: options => {
        const wire = transport.factory(options), send = wire.send.bind(wire);
        wire.send = line => { assert.notEqual(JSON.parse(line).type, 'user'); return send(line); }; return wire;
      } });
      await claude.start();
      let status; const deadline = Date.now() + 20000;
      do { status = await claude.protocol.control({ subtype: 'mcp_status' }); if (JSON.stringify(status).includes(alias) && JSON.stringify(status).includes('connected')) break; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
      assert.ok(JSON.stringify(status).includes(alias)); assert.ok(JSON.stringify(status).includes('connected'));
      await claude.close(); await transport.close();
    } else {
      // No bridge host is needed for this discovery-only fixture.
      codex = new CodexChat({ session, env, bridge: { ...bridge, script: fileURLToPath(new URL('../bridge-mcp.mjs', import.meta.url)) }, sandboxStateDir: path.join(root, 'sandbox') });
      const rpc = codex.rpc.bind(codex); codex.rpc = (method, ...args) => { assert.notEqual(method, 'turn/start'); return rpc(method, ...args); };
      await codex.start();
      const statuses = await codex.rpc('mcpServerStatus/list', { threadId: codex.threadId });
      const status = statuses.data?.find(row => row.name === alias);
      assert.ok(status); assert.ok(Object.keys(status.tools || {}).some(name => name.includes('synthetic_unity_visibility')));
      await codex.close();
    }
    const events = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.length); assert.ok(events.every(event => event.cwd.toLowerCase() === child.toLowerCase()));
    console.log(`PASS actual ${agent}: main-project native MCP discovery from linked folder, original server cwd, no tool calls, no model prompts, synthetic isolated profile.`);
  }
} finally { await claude?.close(); await transport?.close(); await codex?.close(); await launches?.close(); await cleanupFixtures(); }
