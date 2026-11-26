import { lstat, readFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';

// Read native error metadata only. Never execute a command, change ACLs or return
// log contents/config/authentication to the UI.
export async function codexExecutionDiagnostics(home) {
  if (!home || !path.isAbsolute(home)) return { status: 'unavailable' };
  const folder = path.join(home, '.sandbox');
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return { status: 'unavailable' };
  const errorFile = path.join(folder, 'setup_error.json'), errorInfo = await lstat(errorFile).catch(() => null);
  if (!errorInfo?.isFile() || errorInfo.isSymbolicLink() || errorInfo.nlink > 1 || errorInfo.size > 8192) return { status: 'unavailable' };
  let error;
  try { error = JSON.parse(await readFile(errorFile, 'utf8')); } catch { return { status: 'unavailable' }; }
  if (error.code !== 'helper_unknown_error') return { status: 'no-recorded-helper-error' };
  let lockedRuntime = false;
  const files = (await readdir(folder, { withFileTypes: true })).filter(item => item.isFile() && !item.isSymbolicLink() && /^sandbox.*\.log$/.test(item.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 3);
  for (const item of files) {
    const file = path.join(folder, item.name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) continue;
    const handle = await open(file, 'r');
    try {
      const size = Math.min(stat.size, 128000), buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, stat.size - size);
      lockedRuntime ||= buffer.toString('utf8').split('\n').some(line => /runtime read\/execute validation failed/.test(line) && /node_repl\.exe/i.test(line) && /os error 32/.test(line));
    } finally { await handle.close(); }
  }
  return { status: 'recorded-failure', code: 'helper_unknown_error', recordedAt: errorInfo.mtime.toISOString(), lockedRuntime,
    message: lockedRuntime ? 'Windows could not prepare the Codex runtime because node_repl.exe is in use by another process (Windows error 32). Local commands cannot start until that runtime issue is resolved.' : 'The Codex Windows sandbox recorded a setup failure. This can prevent local commands from starting. Review the native sandbox diagnostics before retrying.',
    note: 'This is the last recorded setup failure, not a new execution test. No processes were stopped and permissions were not changed.' };
}
