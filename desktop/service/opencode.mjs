import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openCodeBinary } from './agents.mjs';
import { validSessionId } from './opencode/observer.mjs';
import { forkV2Session } from './opencode-v2-session.mjs';

export { validSessionId };
export function parseOpenCodeVersion(output) {
  const match = /\bv?(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/.exec(output || '');
  if (!match) throw new Error('OpenCode version could not be verified.');
  // Diagnostic information, not a compatibility allowlist. Native contracts
  // and per-action checks determine whether a control can safely be used.
  return match[0].replace(/^v/, '');
}
export function openCodeVersion(env = process.env) {
  const command = openCodeBinary(env), binary = command.file;
  if (!binary) throw new Error('OpenCode CLI is not installed.');
  // Use the same literal Windows wrapper as terminal launches.
  const versionCommand = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(binary)
    ? { file: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand', Buffer.from(`& '${binary.replaceAll("'", "''")}' --version; exit $LASTEXITCODE`, 'utf16le').toString('base64')] }
    : { file: command.file, args: [...command.args, '--version'] };
  const result = spawnSync(versionCommand.file, versionCommand.args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.status !== 0) throw new Error('OpenCode version could not be verified.');
  return parseOpenCodeVersion(result.stdout);
}

export const openCodeStateFile = (stateDir, id) => path.join(stateDir, 'opencode', `${id}.json`);
export async function readOpenCodeState(file, chatId) {
  try {
    if ((await stat(file)).size > 4096) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value.chatId === chatId && validSessionId(value.nativeId) ? value : null;
  } catch { return null; }
}

export function openCodeRuntimeConfig(env, bridge, family = 1) {
  let config;
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}'); }
  catch { throw new Error('OPENCODE_CONFIG_CONTENT is not valid JSON.'); }
  if (!config || Array.isArray(config) || typeof config !== 'object' || config.plugin && !Array.isArray(config.plugin)) throw new Error('OpenCode runtime configuration is invalid.');
  if (family === 2) {
    if (config.plugins && !Array.isArray(config.plugins) || config.permissions && !Array.isArray(config.permissions)) throw new Error('OpenCode V2 runtime configuration is invalid.');
    const plugin = pathToFileURL(fileURLToPath(new URL('./opencode/v2/', import.meta.url))).href;
    config.plugins = [...(config.plugins || []), plugin].filter((value, index, all) => all.indexOf(value) === index);
    if (bridge) {
      config.mcp = { ...config.mcp, servers: { ...config.mcp?.servers, mrmak_workspace: { type: 'local', command: [process.execPath, bridge.script], disabled: false } } };
      const hubSkillIds = bridge.hubSkillIds ?? bridge.hubSkillNames;
      if (hubSkillIds?.length) config.permissions = [...(config.permissions || []), ...hubSkillIds.map(id => ({ action: 'skill', resource: id, effect: 'deny' }))];
    }
    return config;
  }
  const plugin = pathToFileURL(fileURLToPath(new URL('./opencode/plugin.mjs', import.meta.url))).href;
  config.plugin = [...new Set([...(config.plugin || []), plugin])];
  if (bridge) {
    config.mcp = { ...config.mcp, mrmak_workspace: { type: 'local', command: [process.execPath, bridge.script], enabled: true } };
    if (bridge.hubSkillNames?.length) {
      const permission = typeof config.permission === 'string' ? { '*': config.permission } : config.permission || {};
      const skills = typeof permission.skill === 'string' ? { '*': permission.skill } : permission.skill || {};
      config.permission = { ...permission, skill: { ...skills, ...Object.fromEntries(bridge.hubSkillNames.map(name => [name, 'deny'])) } };
    }
  }
  return config;
}

export async function openCodeLaunchEnvironment(session, stateDir, env, bridge) {
  const version = openCodeVersion(env), family = Number(version.split('.')[0]) >= 2 ? 2 : 1;
  if (session.nativeId && !validSessionId(session.nativeId)) throw new Error('Invalid OpenCode conversation ID.');
  const config = openCodeRuntimeConfig(env, bridge, family);
  await mkdir(path.join(stateDir, 'opencode'), { recursive: true });
  const launchId = randomUUID();
  // V2 --session supports an explicit ID for creation. Assign it before startup
  // so plugin loading after session.created cannot lose ownership/context.
  const nativeId = family === 2 && session.openCodeForkParent
    ? await forkV2Session(session.openCodeForkParent, session.cwd, env)
    : session.nativeId || (family === 2 ? `ses_mrmik${randomUUID().replaceAll('-', '')}` : null);
  const tuiFile = path.join(stateDir, 'opencode', `${session.id}.tui.json`);
  // Do not relocate explicit user TUI configuration (relative plugin/theme
  // paths could change meaning). Those chats keep native terminal controls.
  if (family === 1 && !env.OPENCODE_TUI_CONFIG) await writeFile(tuiFile, JSON.stringify({ plugin: [pathToFileURL(fileURLToPath(new URL('./opencode/tui-controls.mjs', import.meta.url))).href] }), { mode: 0o600 });
  return { launchId, family, version, nativeId, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(family === 1 ? { OPENCODE_TUI_CONFIG: env.OPENCODE_TUI_CONFIG || tuiFile } : {}), MRMAK_OPENCODE_CONTROL: path.join(stateDir, 'opencode', `${session.id}.control`),
    MRMAK_OPENCODE_FORK_PARENT: session.openCodeForkParent || '',
    MRMAK_OPENCODE_STATE: openCodeStateFile(stateDir, session.id), MRMAK_OPENCODE_CHAT_ID: session.id,
    MRMAK_OPENCODE_LAUNCH_ID: launchId, MRMAK_OPENCODE_SESSION_ID: nativeId || '', MRMAK_OPENCODE_HAS_CONVERSATION: session.hasConversation || family === 2 && session.openCodeForkParent ? '1' : '0',
    MRMAK_OPENCODE_STARTED_AT: String(Date.now()), MRMAK_OPENCODE_ORIENTATION: bridge?.orientation || '',
  } };
}

export function watchOpenCode(file, chatId, launchId, receive) {
  let stopped = false, busy = false, revision = -1;
  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const state = await readOpenCodeState(file, chatId);
      if (!stopped && state?.launchId === launchId && Number.isInteger(state.revision) && state.revision > revision) { revision = state.revision; receive(state); }
    } finally { busy = false; }
  };
  const timer = setInterval(() => void poll(), 250); timer.unref(); void poll();
  return () => { stopped = true; clearInterval(timer); };
}
