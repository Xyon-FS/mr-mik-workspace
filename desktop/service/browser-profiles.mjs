import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, open, readFile, unlink, rm, writeFile, rename } from 'node:fs/promises';

export const browserProfileRoot = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local/share'), 'MrMik', 'browser-profiles');
const key = value => createHash('sha256').update(value).digest('hex');
export class BrowserProfiles {
  constructor(root = browserProfileRoot(), hub = '') { this.root = path.resolve(root); this.hub = hub; }
  async location(session, channel) {
    await mkdir(this.root, { recursive: true });
    const info = await lstat(this.root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Browser profile storage is unavailable.');
    const root = await realpath(this.root);
    const identity = JSON.stringify([this.hub, session.projectId || null, session.id, channel]);
    return { root, folder: path.join(root, key(identity)), lock: path.join(root, `${key(identity)}.lock`) };
  }
  async acquire(session, channel) {
    const location = await this.location(session, channel);
    let handle;
    try { handle = await open(location.lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Browser profile storage is unavailable.');
      const info = await lstat(location.lock);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Browser profile is locked.');
      const pid = Number(await readFile(location.lock, 'utf8'));
      let absent = false;
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (cause) { absent = cause.code === 'ESRCH'; }
      if (!absent) throw new Error('Browser profile is in use. Close its other browser session first.');
      const current = await lstat(location.lock);
      if (current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) throw new Error('Browser profile is locked.');
      await unlink(location.lock);
      handle = await open(location.lock, 'wx').catch(() => { throw new Error('Browser profile is in use.'); });
    }
    await handle.writeFile(String(process.pid));
    const lockInfo = await handle.stat();
    let released = false;
    const release = async () => {
      if (released) return;
      await handle.close();
      const current = await lstat(location.lock);
      if (current.isSymbolicLink() || current.ino !== lockInfo.ino || current.mtimeMs !== lockInfo.mtimeMs) throw new Error('Browser profile lock changed; retained for review.');
      await unlink(location.lock); released = true;
    };
    try {
      await mkdir(location.folder, { recursive: true });
      const info = await lstat(location.folder);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(location.folder) !== location.folder) throw new Error('Browser profile storage changed.');
      return { folder: location.folder, release };
    } catch (error) { await release(); throw error; }
  }
  async clear(session, channel) {
    const lease = await this.acquire(session, channel);
    try {
      const info = await lstat(lease.folder);
      if (info.isSymbolicLink() || await realpath(lease.folder) !== lease.folder) throw new Error('Browser profile storage changed.');
      // rm removes contained links themselves, never their external targets.
      await rm(lease.folder, { recursive: true, maxRetries: 4, retryDelay: 100 });
    } finally { await lease.release(); }
  }
  async storageFile(lease) {
    const info = await lstat(lease.folder);
    if (info.isSymbolicLink() || await realpath(lease.folder) !== lease.folder) throw new Error('Browser profile storage changed.');
    return path.join(lease.folder, 'mr-mik-website-state.json');
  }
  async restore(lease, context) {
    const file = await this.storageFile(lease);
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Browser profile storage changed.');
    await context.setStorageState(JSON.parse(await readFile(file, 'utf8')));
  }
  async save(lease, context) {
    const file = await this.storageFile(lease);
    const { cookies, origins } = await context.storageState({ indexedDB: true });
    const staging = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, JSON.stringify({ cookies, origins }), { flag: 'wx', mode: 0o600 });
      await rename(staging, file);
    } finally { await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
