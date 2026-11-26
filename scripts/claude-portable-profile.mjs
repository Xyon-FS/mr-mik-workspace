import path from 'node:path';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { claudeBinary } from '../desktop/service/agents.mjs';
import { createHash } from 'node:crypto';

export function isolatedClaudeEnvironment(profileRoot, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_USE_|MRMAK_BRIDGE_|MRMAK_PARENT_PID$|MRMAK_TOKEN$|WEBVIEW2_|OPENCODE_CONFIG)/i.test(key)) delete env[key];
  return { ...env, CLAUDE_CONFIG_DIR: path.join(profileRoot, 'Claude'), CODEX_HOME: path.join(profileRoot, 'Codex'),
    XDG_CONFIG_HOME: path.join(profileRoot, 'xdg-config'), XDG_DATA_HOME: path.join(profileRoot, 'xdg-data'), XDG_CACHE_HOME: path.join(profileRoot, 'xdg-cache'), XDG_STATE_HOME: path.join(profileRoot, 'xdg-state'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(profileRoot, 'WebView2'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export function isolatedClaudeStatus(profileRoot) {
  const env = isolatedClaudeEnvironment(profileRoot), binary = claudeBinary(env);
  const result = spawnSync(binary.file, [...binary.args, 'auth', 'status'], { env, cwd: profileRoot, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  let auth; try { auth = JSON.parse(result.stdout); } catch { throw new Error('Claude did not return a readable authentication status. No prompt was sent.'); }
  // Return only routing facts. Never persist or print the account response.
  return { loggedIn: auth.loggedIn === true, authMethod: auth.authMethod || 'unknown', apiProvider: auth.apiProvider || null, configDirectory: auth.configDirectory || null };
}

export async function prepareClaudePortable(portable) {
  portable = path.resolve(portable);
  for (const name of ['App/mrmak-workspace.exe', 'App/runtime/node.exe', 'MyHub/workspace/workspace.json']) {
    const info = await lstat(path.join(portable, name)); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose an unpacked Mr. Mik portable.');
  }
  const profileRoot = path.join(path.dirname(portable), 'Claude-Test-Profile');
  if (await lstat(profileRoot).catch(() => null)) throw new Error('The dedicated test profile already exists; it has not been changed.');
  for (const name of ['Claude', 'Codex', 'WebView2', 'xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state']) await mkdir(path.join(profileRoot, name), { recursive: true });
  const config = { version: 1, portable, profileRoot, hub: path.join(portable, 'MyHub'), maxPrompts: 10 };
  await writeFile(path.join(profileRoot, 'test-profile.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const status = isolatedClaudeStatus(profileRoot);
  if (status.loggedIn) throw new Error('The fresh profile unexpectedly inherited authentication. Do not run live tests until isolation is resolved.');
  const script = fileURLToPath(import.meta.url), node = path.join(portable, 'App/runtime/node.exe');
  for (const [name, action] of [['Start isolated Claude test.cmd', 'launch'], ['Sign in isolated Claude.cmd', 'login'], ['Check isolated Claude.cmd', 'status']]) {
    const command = `@echo off\r\nsetlocal\r\n"${node}" "${script}" --${action} "${profileRoot}"\r\n${action === 'launch' ? '' : 'pause\r\n'}`;
    await writeFile(path.join(path.dirname(portable), name), command, { flag: 'wx' });
  }
  await writeFile(path.join(path.dirname(portable), 'CLAUDE-TEST-README.txt'), 'Use Start isolated Claude test.cmd, not the standard portable launcher, for this test.\nSign in only through Sign in isolated Claude.cmd or the test app Accounts view; complete the native Anthropic flow yourself.\nThe original installed app, Hub and Claude config are not replaced. This test profile and its native conversations are retained intentionally. Do not share Claude-Test-Profile, MyHub/.mrmak or a copy of the portable after login. The pristine portable ZIP was created before any login.\nLive testing is limited to ten very short prompts with the least costly available native model and subscription authentication. No API keys are configured by the harness.\n', { flag: 'wx' });
  return { ...config, status };
}

async function main() {
  const args = process.argv.slice(2), [mode, location] = args;
  if (!location || !['--prepare', '--launch', '--login', '--status'].includes(mode)) throw new Error('Usage: node scripts/claude-portable-profile.mjs --prepare <portable> | --launch/--login/--status <profile>');
  if (mode === '--prepare') { const config = await prepareClaudePortable(location); console.log(`Isolated portable prepared. Fresh Claude profile authenticated: ${config.status.loggedIn}. No login or model request performed.\n${path.dirname(config.portable)}`); return; }
  const profile = path.resolve(location), config = JSON.parse(await readFile(path.join(profile, 'test-profile.json'), 'utf8'));
  if (config.profileRoot !== profile || config.version !== 1) throw new Error('Invalid dedicated test profile.');
  const alternate = args.indexOf('--portable');
  if (alternate >= 0) {
    if (mode !== '--launch' || !args[alternate + 1]) throw new Error('An alternate portable is supported only for launching a test build.');
    config.portable = path.resolve(args[alternate + 1]); config.hub = path.join(config.portable, 'MyHub');
    for (const name of ['App/mrmak-workspace.exe', 'MyHub/workspace/workspace.json']) {
      const info = await lstat(path.join(config.portable, name)); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a valid unpacked test portable.');
    }
  }
  if (mode === '--status') { const status = isolatedClaudeStatus(profile); console.log(JSON.stringify({ loggedIn: status.loggedIn, authMethod: status.authMethod, apiProvider: status.apiProvider }, null, 2)); return; }
  const env = isolatedClaudeEnvironment(profile);
  if (mode === '--launch') env.WEBVIEW2_USER_DATA_FOLDER = path.join(profile, 'WebView2', createHash('sha256').update(config.portable.toLowerCase()).digest('hex').slice(0, 16));
  if (mode === '--login') {
    const binary = claudeBinary(env);
    const child = spawn(binary.file, [...binary.args, 'auth', 'login'], { cwd: profile, env, stdio: 'inherit', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Native Claude login did not complete.'))); });
  } else {
    const child = spawn(path.join(config.portable, 'App/mrmak-workspace.exe'), ['--repo', config.hub], { cwd: config.portable, env, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; }); child.unref();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
