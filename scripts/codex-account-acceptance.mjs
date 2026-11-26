// User-run, retained acceptance environment. Never run automatically in CI.
// Native login and model prompts are entered by the user in native terminals.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, open, writeFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { codexBinary } from '../desktop/service/agents.mjs';
import { prepareCodexProfileLayout, inspectCodexProfileLayout, codexProfileEnvironment, realProfileDirectory, withCodexStoreStartup } from '../desktop/service/codex-profile-layout.mjs';
import { NativeProfileProbe } from '../desktop/service/test/codex-profile-probe.mjs';

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const encode = text => Buffer.from(text, 'utf16le').toString('base64');
const runName = /^run-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function createAcceptanceEnvironment(parent) {
  const base = await realProfileDirectory(parent, true);
  const root = path.join(base, 'run-' + randomUUID());
  await mkdir(root, { mode: 0o700 });
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const sharedHome = path.join(root, 'shared'), sqliteHome = path.join(root, 'sqlite');
  const profiles = await Promise.all(['A', 'B'].map(name => prepareCodexProfileLayout({ privateHome: path.join(root, 'profile-' + name), sharedHome, sqliteHome })));
  return { root, workspace, profiles };
}

export async function loadAcceptanceEnvironment(parent, name) {
  if (typeof name !== 'string' || !runName.test(name)) throw new Error('Choose a retained acceptance run name, not an arbitrary path.');
  const base = await realProfileDirectory(parent);
  const root = await realProfileDirectory(path.join(base, name));
  const workspace = await realProfileDirectory(path.join(root, 'workspace'));
  const sharedHome = path.join(root, 'shared'), sqliteHome = path.join(root, 'sqlite');
  const profiles = await Promise.all(['A', 'B'].map(label => inspectCodexProfileLayout({ privateHome: path.join(root, 'profile-' + label), sharedHome, sqliteHome })));
  return { root, workspace, profiles };
}

export async function listAcceptanceEnvironments(parent) {
  const base = await realProfileDirectory(parent, true), runs = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !runName.test(entry.name)) continue;
    try {
      const environment = await loadAcceptanceEnvironment(base, entry.name);
      runs.push({ name: entry.name, modifiedAt: (await stat(environment.root)).mtimeMs });
    } catch { /* A partial/foreign/relinked layout is never auto-repaired. */ }
  }
  return runs.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

export function acceptanceChatCommand(binary, nativeId) {
  if (nativeId !== undefined && !uuid.test(nativeId)) throw new Error('Invalid native test conversation UUID.');
  // The background daemon uses an AF_UNIX socket beneath CODEX_HOME on Windows.
  // Retained private homes exceed SUN_LEN. The supported foreground mode avoids
  // that socket without moving/copying authentication or changing native config.
  return { file: binary.file, args: [...binary.args, ...(nativeId ? ['resume', nativeId] : []), '--no-daemon', '--no-alt-screen'] };
}

export async function acceptanceTranscript(sharedHome, nativeId) {
  if (!uuid.test(nativeId)) throw new Error('Use a native conversation UUID from this acceptance environment.');
  const shared = await realProfileDirectory(sharedHome);
  const pending = [await realProfileDirectory(path.join(shared, 'sessions'))], matches = [];
  while (pending.length) {
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(`-${nativeId.toLowerCase()}.jsonl`)) {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(65536), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
          let metadata; try { metadata = JSON.parse(first); } catch { continue; }
          if (metadata.type === 'session_meta' && metadata.payload?.id === nativeId && metadata.payload?.originator === 'mr_mik_account_acceptance_A') matches.push(file);
        } finally { await handle.close(); }
      }
    }
  }
  if (matches.length !== 1) throw new Error('The ID does not identify exactly one account A test conversation. No resume was started.');
  return nativeId;
}

async function runNative(command, env, cwd) {
  const child = spawn(command.file, command.args, { cwd, env, stdio: 'inherit', windowsHide: false });
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Native CLI could not start.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Native command did not complete successfully. Its output stays in this terminal.')));
  });
}

async function openChatWindow(profile, name, cwd, nativeId) {
  const env = codexProfileEnvironment(process.env, profile.privateHome, profile.sqliteHome);
  // This is a visible Windows Terminal/conhost console, not the host tool's
  // captured-output terminal. Do not inherit TERM=dumb from that launcher.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'mr_mik_account_acceptance_' + name;
  const command = acceptanceChatCommand(codexBinary(env), nativeId);
  // Visible interactive windows are explicitly requested by menu actions.
  // Defaults retain native approvals; no bypass or automatic prompt is added.
  // NonInteractive applies to PowerShell only, preventing its optional
  // PSReadLine auto-import. The native CLI still owns the visible console.
  // Console.ReadLine keeps the exit UUID visible without PowerShell Read-Host.
  const script = `$Host.UI.RawUI.WindowTitle = 'Mr. Mik - Codex account ${name} acceptance'; Set-Location -LiteralPath ${quote(cwd)}; & ${[command.file, ...command.args].map(quote).join(' ')}; Write-Host 'Native CLI stopped. Press Enter to close this test window'; [void][Console]::ReadLine()`;
  const launch = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encode(script)}') -WindowStyle Normal -PassThru -ErrorAction Stop; Write-Output $p.Id`;
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launch)], { env, cwd, windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  const pid = Number(stdout.trim()); if (!Number.isInteger(pid) || pid <= 0) throw new Error('The native test window could not be tracked.');
  return pid;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

export async function inspectAcceptanceAccounts(environment) {
  const accounts = [];
  for (const profile of environment.profiles) {
    const env = codexProfileEnvironment(process.env, profile.privateHome, profile.sqliteHome);
    accounts.push(await withCodexStoreStartup(profile.sqliteHome, async () => {
      const probe = new NativeProfileProbe(environment.workspace, env);
      try { await probe.config(); return await probe.account(); }
      finally { await probe.close(); }
    }));
  }
  // Email is compared only in memory, then discarded. Reports contain no email,
  // account identifiers, raw RPC output, credentials or conversation contents.
  return { profileA: accounts[0]?.type === 'chatgpt' ? 'logged-in' : accounts[0] ? 'unsupported-account-kind' : 'logged-out', profileB: accounts[1]?.type === 'chatgpt' ? 'logged-in' : accounts[1] ? 'unsupported-account-kind' : 'logged-out', distinctChatGptIdentities: accounts.every(account => account?.type === 'chatgpt' && account.email) ? accounts[0].email.trim().toLowerCase() !== accounts[1].email.trim().toLowerCase() : null };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This guided native acceptance currently targets Windows.');
  const parent = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MrMik', 'AccountAcceptance');
  const selection = createInterface({ input: process.stdin, output: process.stdout });
  let environment;
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--new') && !(args.length === 2 && args[0] === '--reuse')) throw new Error('Use --new or --reuse run-<UUID>.');
    if (args[0] === '--reuse') environment = await loadAcceptanceEnvironment(parent, args[1]);
    else if (args[0] !== '--new') {
      const runs = await listAcceptanceEnvironments(parent);
      if (runs.length) {
        console.log('\nRetained acceptance environments (close their old test windows before reuse):');
        runs.forEach((run, index) => console.log(`${index + 1} ${run.name}`));
        const answer = (await selection.question('Reuse number [Enter = 1], or N for a new environment: ')).trim();
        if (answer.toLowerCase() !== 'n') {
          const index = answer === '' ? 0 : /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
          if (!runs[index]) throw new Error('No matching retained acceptance environment. Nothing was changed.');
          environment = await loadAcceptanceEnvironment(parent, runs[index].name);
        }
      }
    }
    if (!environment) environment = await createAcceptanceEnvironment(parent);
  } finally { selection.close(); }
  const rl = createInterface({ input: process.stdin, output: process.stdout }), windows = new Set();
  const currentWindows = () => [...windows].filter(alive);
  const report = { format: 'mr-mik-codex-account-acceptance', version: 1, createdAt: new Date().toISOString(), modelRequestsSubmittedByHarness: 0, currentSystemProfileModified: false, checks: {} };
  const saveReport = () => writeFile(path.join(environment.root, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const envFor = index => codexProfileEnvironment(process.env, environment.profiles[index].privateHome, environment.profiles[index].sqliteHome);
  console.log('\nCodex multi-account acceptance — isolated from the installed Mr. Mik.');
  console.log('Retained test data: ' + environment.root);
  console.log('Chat mode: foreground (--no-daemon), avoiding the Windows daemon socket path limit.');
  console.log('Credentials stay in these two native profiles. Keep this directory private.');
  console.log('Use test prompts only. A native turn uses the selected account and its budget.');
  try {
    // Initialize once before interactive login/parallel windows; no auth copied.
    await withCodexStoreStartup(environment.profiles[0].sqliteHome, async () => {
      const bootstrap = new NativeProfileProbe(environment.workspace, envFor(0));
      try { await bootstrap.config(); }
      finally { await bootstrap.close(); }
    });
    for (;;) {
      console.log('\n1 Sign in A   2 Sign in B   3 Check both logins');
      console.log('4 Open test chat A   5 Open test chat B (may run together)');
      console.log('6 Resume account A test conversation with B (close both chat windows first)');
      console.log('7 Sign out B / verify A remains signed in   0 Finish');
      const choice = (await rl.question('Choose: ')).trim();
      try {
        if (choice === '0') { await saveReport(); console.log('Report saved. Test profiles are retained; no user terminals were terminated.'); if (currentWindows().length) console.log('Close your native test windows when finished.'); break; }
        if (['1', '2', '7'].includes(choice)) {
          if (currentWindows().length) throw new Error('Close the test chat windows before changing a test account. Installed Mr. Mik chats can stay open.');
          const index = choice === '1' ? 0 : 1, env = envFor(index), binary = codexBinary(env);
          rl.pause();
          try { await withCodexStoreStartup(environment.profiles[index].sqliteHome, () => runNative({ file: binary.file, args: [...binary.args, choice === '7' ? 'logout' : 'login'] }, env, environment.workspace)); }
          finally { rl.resume(); }
          if (choice === '7') {
            const status = await inspectAcceptanceAccounts(environment);
            report.checks.logoutBPreservesA = status.profileA === 'logged-in' && status.profileB === 'logged-out';
            console.log(JSON.stringify(status, null, 2)); await saveReport();
          }
        } else if (choice === '3') {
          const status = await inspectAcceptanceAccounts(environment); report.checks.localAccountStatus = status;
          console.log(JSON.stringify(status, null, 2)); await saveReport();
        } else if (choice === '4' || choice === '5') {
          const index = choice === '4' ? 0 : 1;
          const status = await inspectAcceptanceAccounts(environment);
          if (status[index === 0 ? 'profileA' : 'profileB'] !== 'logged-in') throw new Error('Sign in to the selected ChatGPT test account first.');
          windows.add(await openChatWindow(environment.profiles[index], index === 0 ? 'A' : 'B', environment.workspace));
        } else if (choice === '6') {
          if (currentWindows().length) throw new Error('Close BOTH native test chat windows first. No active conversation may be switched.');
          const status = await inspectAcceptanceAccounts(environment);
          if (status.profileB !== 'logged-in' || status.distinctChatGptIdentities !== true) throw new Error('Two different signed-in ChatGPT identities are required before this test.');
          const nativeId = await acceptanceTranscript(environment.profiles[0].sharedHome, (await rl.question('Conversation UUID shown by account A on exit: ')).trim());
          windows.add(await openChatWindow(environment.profiles[1], 'B', environment.workspace, nativeId));
          report.checks.crossAccountResume = 'opened-for-user-verification'; await saveReport();
          console.log('Check that B shows the SAME conversation. Resume success and token refresh require your observation; this report does not claim they passed.');
        } else console.log('Choose a listed action.');
      } catch (error) { console.log(error.message); }
    }
  } finally { rl.close(); await saveReport(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
