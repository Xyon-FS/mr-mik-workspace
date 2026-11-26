import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
export function privateBrowserEnvironment(env = process.env) {
  // Supply OS/runtime locations only; never inherit app/API/account secrets.
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData|ALLUSERSPROFILE|PUBLIC|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|SESSIONNAME|USERNAME|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|OS)$/i.test(key)));
}
export function privateBrowserCandidates(env = process.env) {
  return [
    ...[env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean).map(root => ({ file: path.join(root, 'Microsoft/Edge/Application/msedge.exe'), privateFlag: '--inprivate' })),
    ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).map(root => ({ file: path.join(root, 'Google/Chrome/Application/chrome.exe'), privateFlag: '--incognito' })),
  ];
}

// Normal browser process: no Playwright, DevTools, injected scripts, request
// interception, fingerprint changes or challenge retries in the login window.
export async function launchNativePrivateBrowser(url, { candidates = privateBrowserCandidates(), spawnProcess = spawn, temporaryRoot = os.tmpdir(),
  stopProcess = async child => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(error => { if (child.exitCode == null && child.signalCode == null) throw error; });
    else child.kill();
  } } = {}) {
  const selected = candidates.find(browser => path.isAbsolute(browser.file) && existsSync(browser.file));
  if (!selected) throw new Error('Install Microsoft Edge or Google Chrome to open a private sign-in window.');
  const parent = await realpath(temporaryRoot);
  const folder = await mkdtemp(path.join(parent, 'mr-mik-private-login-'));
  const identity = await lstat(folder);
  const cleanup = async () => {
    const current = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!current) return;
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || await realpath(folder) !== folder || path.dirname(folder) !== parent) throw new Error('Private browser cleanup refused a replaced profile.');
    // rm removes contained symlinks themselves, never their targets.
    await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  let child, exited = false, closing;
  const callbacks = new Set();
  try {
    // Edge otherwise may relaunch via a compatibility helper and detach the
    // actual browser from the owned process. Keep the real window/PID owned.
    child = spawnProcess(selected.file, [selected.privateFlag, ...(selected.privateFlag === '--inprivate' ? ['--edge-skip-compat-layer-relaunch'] : []), `--user-data-dir=${folder}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window', url], { env: privateBrowserEnvironment(), windowsHide: true, shell: false, stdio: 'ignore' });
    const ended = new Promise(resolve => {
      const end = () => { if (exited) return; exited = true; for (const callback of callbacks) callback(); resolve(); };
      child.once('exit', end); child.once('error', end);
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('The private browser could not start.'))); });
    return {
      onClose: callback => { callbacks.add(callback); if (exited) callback(); },
      close: () => closing ||= (async () => {
        if (!exited) await stopProcess(child);
        let timer;
        try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The private browser did not exit; its temporary profile was retained.')), 10000); })]); }
        finally { clearTimeout(timer); }
        try { await cleanup(); }
        catch { throw new Error('The temporary sign-in profile could not be removed. Close its private browser and retry cleanup.'); }
      })(),
    };
  } catch (error) {
    if (!child?.pid || exited) await cleanup();
    throw error;
  }
}
