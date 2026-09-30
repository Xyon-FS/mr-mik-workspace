import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';

const claudeCapabilities = new Map();
export function claudePromptRefreshSupported(binary = claudeBinary()) {
  if (claudeCapabilities.has(binary.file)) return claudeCapabilities.get(binary.file);
  const result = spawnSync(binary.file, [...binary.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(result.stdout || '');
  const supported = !!version && (+version[1] > 2 || +version[1] === 2 && (+version[2] > 1 || +version[2] === 1 && +version[3] >= 257));
  claudeCapabilities.set(binary.file, supported); return supported;
}

export const AGENTS = [
  { id: 'codex', label: 'Codex', color: '#88d8bf', command: 'codex', subscription: true },
  { id: 'claude', label: 'Claude Code', color: '#dba68c', command: 'claude', subscription: true },
  { id: 'kimi', label: 'Kimi', color: '#b3a3f7', command: 'kimi', subscription: true },
  { id: 'shell', label: 'PowerShell', color: '#89b7ed', command: 'powershell.exe', subscription: false },
];

export function commandPath(name, env = process.env) {
  if (path.isAbsolute(name) && existsSync(name)) return name;
  const extra = [path.join(env.APPDATA || '', 'npm'), path.join(os.homedir(), '.kimi-code', 'bin'), path.join(os.homedir(), '.local', 'bin'),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : [])];
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const folder of [...String(env.PATH || env.Path || '').split(path.delimiter), ...extra]) {
    for (const ext of extensions) {
      const candidate = path.join(folder, name.toLowerCase().endsWith(ext) && ext ? name : name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function inventory(env = process.env) {
  return AGENTS.map(agent => ({ ...agent, available: !!commandPath(agent.command, env) }));
}

// Resolve the real Codex binary when available so JSON-RPC does not pass through a shell.
export function codexBinary(env = process.env) {
  const npmRoot = path.join(env.APPDATA || '', 'npm', 'node_modules', '@openai');
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const platformPackage = `codex-win32-${process.arch}`;
  for (const root of [path.join(npmRoot, 'codex', 'node_modules', '@openai', platformPackage), path.join(npmRoot, platformPackage), path.join(npmRoot, 'codex')]) {
    for (const directory of ['bin', 'codex']) {
      const candidate = path.join(root, 'vendor', triple, directory, 'codex.exe');
      if (existsSync(candidate)) return { file: candidate, args: [] };
    }
  }
  const js = path.join(npmRoot, 'codex', 'bin', 'codex.js');
  if (existsSync(js)) return { file: process.execPath, args: [js] };
  const executable = commandPath('codex', env);
  if (executable && !/\.(cmd|bat|ps1)$/i.test(executable)) return { file: executable, args: [] };
  throw new Error('Codex CLI is not installed. Install it and sign in once to use Mr. Mik.');
}

// Native and npm Claude installations must bypass PowerShell's JSON marshalling.
export function claudeBinary(env = process.env) {
  const executable = commandPath('claude', env);
  if (executable && !/\.(cmd|bat|ps1)$/i.test(executable)) return { file: executable, args: [] };
  const roots = [path.join(env.APPDATA || '', 'npm'), ...(executable ? [path.dirname(executable)] : [])];
  for (const root of roots) {
    const script = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(script)) return { file: process.execPath, args: [script] };
  }
  throw new Error('Claude Code executable could not be located. Install the native CLI or its standard npm package.');
}

export function codexBridgeArgs(script) {
  const tomlString = value => JSON.stringify(value);
  return ['-c', `mcp_servers.mrmak_workspace.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.mrmak_workspace.args=[${tomlString(script)}]`,
    '-c', 'mcp_servers.mrmak_workspace.env_vars=["MRMAK_BRIDGE_URL","MRMAK_BRIDGE_TOKEN"]',
    '-c', 'mcp_servers.mrmak_workspace.enabled=true'];
}

export function claudeBridgeArgs(script) {
  // Keep the scoped grant in environment variables, never in command-line arguments.
  const config = { mcpServers: { mrmak_workspace: {
    type: 'stdio', command: process.execPath, args: [script],
    env: { MRMAK_BRIDGE_URL: '${MRMAK_BRIDGE_URL}', MRMAK_BRIDGE_TOKEN: '${MRMAK_BRIDGE_TOKEN}' },
  } } };
  return ['--mcp-config', JSON.stringify(config)];
}

export function terminalCommand(agent, { bypass = false, resumeId, resumePath, nativeId, effort, bridge, cwd, fork = false } = {}) {
  if (!AGENTS.some(item => item.id === agent)) throw new Error('Unknown agent');
  const binary = agent === 'codex' ? codexBinary() : agent === 'claude' ? claudeBinary() : { file: commandPath(AGENTS.find(item => item.id === agent).command), args: [] };
  if (!binary.file) throw new Error(`${agent} is not installed on this computer`);
  const args = [];
  if (agent === 'codex') {
    if (resumeId) args.push(fork ? 'fork' : 'resume', resumeId);
    if (resumeId && cwd) args.push('--cd', cwd);
    // Inline mode retains xterm scrollback for new and resumed conversations.
    args.push('--no-alt-screen');
    if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (bridge) {
      args.push(...codexBridgeArgs(bridge.script));
      if (bridge.instructions) args.push('-c', `developer_instructions=${JSON.stringify(bridge.instructions)}`);
    }
  } else if (agent === 'claude') {
    if (resumeId) args.push('--resume', resumePath || resumeId);
    else if (nativeId) args.push('--session-id', nativeId);
    if (fork) args.push('--fork-session', '--session-id', nativeId);
    if (bypass) args.push('--dangerously-skip-permissions');
    if (effort) args.push('--effort', effort);
    if (bridge) {
      args.push(...claudeBridgeArgs(bridge.script));
      if (bridge.orientation) args.push('--append-system-prompt', bridge.orientation);
      if (bridge.settings && Object.keys(bridge.settings).length) args.push('--settings', JSON.stringify(bridge.settings));
      if (resumeId && bridge.orientation && claudePromptRefreshSupported(binary)) args.push('--system-prompt-snapshot', 'off');
    }
  } else if (agent === 'kimi') {
    if (resumeId) args.push('--session', resumeId);
    if (bypass) args.push('--yolo');
  } else {
    args.push('-NoLogo');
  }
  // Pass Codex TOML and Claude JSON directly: Windows PowerShell strips embedded
  // quotes, turning Claude's --mcp-config JSON into an invalid filename.
  if (agent === 'codex' || agent === 'claude' || process.platform !== 'win32' || agent === 'shell') return { file: binary.file, args: [...binary.args, ...args] };
  // Keep the remaining shell-wrapper arguments literal. No -NoExit:
  // after the agent exits, stale coordinator input cannot become shell commands.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & ${[binary.file, ...binary.args, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

export function childEnvironment(repo) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // Forward only explicitly named MCP credentials. Voice and unrelated API keys
  // stay private to the service; CLI subscription authentication is unchanged.
  if (repo) {
    const values = parseEnv(readDotEnv(path.join(repo, '.env')));
    for (const [name, value] of Object.entries(values)) if (/^MRMAK_MCP_[A-Z0-9_]+$/.test(name) && !env[name]) env[name] = value;
  }
  // Drop host-agent identity from the parent so every terminal is an independent CLI.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|CODEX_TURN_ID|CODEX_SHELL|MRMAK_TOKEN|MRMAK_PARENT_PID|MRMAK_BRIDGE_URL|MRMAK_BRIDGE_TOKEN)$/.test(key)) delete env[key];
  }
  return env;
}

export function readDotEnv(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}
