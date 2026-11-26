import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { realProfileDirectory } from './codex-profile-layout.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const conflictMessage = 'This native conversation is already owned by another Mr. Mik chat, or has a retained crash lock. Close its other writer; do not start a duplicate.';

function processAbsent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function windowsBootTime() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString("o")'], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    const time = Date.parse(stdout.trim());
    return Number.isFinite(time) && time > 0 && time <= Date.now() ? time : null;
  } catch { return null; }
}

// Only a proven previous-boot lock is eligible. A dead service on the same boot
// may have surviving native children, so a missing PID alone is insufficient.
// Exported separately for isolated tests; production obtains boot time from Windows.
export async function recoverPreviousBootLease(file, bootTime, ownerAbsent = processAbsent) {
  if (!Number.isFinite(bootTime) || bootTime <= 0 || bootTime > Date.now()) return false;
  const guard = file + '.recovery';
  const guardValue = JSON.stringify({ owner: randomUUID(), pid: process.pid });
  try { await writeFile(guard, guardValue, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    // Leave a margin around boot time for timestamp precision and clock adjustment.
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mtimeMs >= bootTime - 60000 || info.birthtimeMs >= bootTime - 60000) return false;
    const bytes = await readFile(file, 'utf8');
    let previous;
    try { previous = JSON.parse(bytes); } catch { return false; }
    if (!previous || typeof previous.owner !== 'string' || !previous.owner || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !ownerAbsent(previous.pid)) return false;
    const fresh = await lstat(file);
    if (fresh.ino !== info.ino || fresh.mtimeMs !== info.mtimeMs || fresh.nlink !== 1 || fresh.isSymbolicLink() || await readFile(file, 'utf8') !== bytes) return false;
    // Retain diagnostic evidence. Never delete or rewrite a replacement owner's lock.
    await rename(file, file + '.recovered-' + randomUUID() + '.json');
    return true;
  } finally {
    const info = await lstat(guard);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(guard, 'utf8') !== guardValue) throw new Error('Conversation recovery guard changed; retained for review.');
    await unlink(guard);
  }
}

// Cross-service single-writer guard. External native clients do not participate.
// Unknown/same-boot crash locks fail closed; never steal based on a PID alone.
export async function leaseConversation(context, nativeId) {
  if (!/^[a-f0-9-]{36}$/i.test(nativeId)) throw new Error('Cannot lease an invalid native conversation.');
  const folder = await realProfileDirectory(path.join(context.directory || context.sqliteHome, 'mr-mik-conversation-leases'), true);
  const file = path.join(folder, createHash('sha256').update(nativeId.toLowerCase()).digest('hex') + '.lock');
  const value = JSON.stringify({ owner: randomUUID(), pid: process.pid });
  try { await writeFile(file, value, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!await recoverPreviousBootLease(file, await windowsBootTime())) throw new Error(conflictMessage);
    try { await writeFile(file, value, { flag: 'wx', mode: 0o600 }); }
    catch (retryError) { if (retryError.code === 'EEXIST') throw new Error(conflictMessage); throw retryError; }
  }
  let released = false;
  return async () => {
    if (released) return;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || await readFile(file, 'utf8') !== value) throw new Error('Conversation lease changed; retained for review.');
    await unlink(file); released = true;
  };
}
