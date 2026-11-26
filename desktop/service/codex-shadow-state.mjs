import { lstat, mkdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const shadowRuntimeDirectories = ['.sandbox', '.sandbox-secrets', '.sandbox-bin', 'shell_snapshots', 'worktrees', 'cache', 'logs', 'mcp-oauth-locks', 'sqlite'];
const info = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// Only named, reviewed state directories are shared. Never traverse or copy
// native secrets, and never replace authentication files or unknown entries.
export async function linkShadowRuntime(home, shared, metadata, { dryRun = false } = {}) {
  const planned = [], linked = [], moved = [];
  for (const name of shadowRuntimeDirectories) {
    const target = path.join(shared, name), local = path.join(home, name);
    const common = await info(target), entry = await info(local);
    if (common && (!common.isDirectory() || common.isSymbolicLink())) throw new Error(`Shared Codex runtime directory conflict: ${name}`);
    if (entry?.isSymbolicLink()) {
      if (!common || !same(await realpath(local).catch(() => ''), await realpath(target))) throw new Error(`Shadow Codex runtime link conflict: ${name}`);
      continue;
    }
    if (entry && (!entry.isDirectory() || !metadata || metadata.version >= 3)) throw new Error(`Shadow Codex runtime entry conflict: ${name}`);
    planned.push({ name, target, local, retained: entry ? `${name}-retained-${randomUUID()}` : null });
  }
  if (dryRun) return;
  const journal = planned.some(item => item.retained) ? path.join(home, `shadow-migration-${randomUUID()}.json`) : null;
  const record = state => journal ? writeFile(journal, JSON.stringify({ version: 1, state, fromVersion: metadata.version, toVersion: 3, entries: planned.map(({ name, retained }) => ({ name, retained })) }) + '\n', { mode: 0o600 }) : Promise.resolve();
  if (journal) await writeFile(journal, '', { flag: 'wx', mode: 0o600 });
  const rollback = async () => {
    const failures = [];
    for (const item of [...linked].reverse()) try {
      const entry = await info(item.local);
      if (!entry?.isSymbolicLink() || !same(await realpath(item.local), await realpath(item.target))) throw new Error('Migration link was replaced');
      await unlink(item.local);
    } catch (error) { failures.push(error); }
    for (const item of [...moved].reverse()) try {
      if (await info(item.local)) throw new Error('Migration source was replaced');
      await rename(path.join(home, item.retained), item.local);
    } catch (error) { failures.push(error); }
    await record(failures.length ? 'recovery-required' : 'rolled-back');
    if (failures.length) throw new AggregateError(failures, 'Codex shadow migration rollback requires review; all retained state was preserved.');
  };
  try {
    await record('prepared');
    for (const item of planned) {
      if (!await info(item.target)) await mkdir(item.target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const common = await info(item.target);
      if (!common?.isDirectory() || common.isSymbolicLink()) throw new Error('Shared runtime directory changed during migration');
      if (item.retained) { await rename(item.local, path.join(home, item.retained)); moved.push(item); }
      await symlink(item.target, item.local, process.platform === 'win32' ? 'junction' : 'dir'); linked.push(item);
    }
    return { rollback, commit: () => record('completed') };
  } catch (error) { await rollback(); throw error; }
}
