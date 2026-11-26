import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, mkdir, copyFile, rename, unlink, rmdir, readFile, open, readdir } from 'node:fs/promises';
import { within } from './util.mjs';

const info = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

// Validate each existing component, including the final file. The selected root
// may have a canonical spelling; links beneath it never grant additional scope.
export async function transferTarget(root, file, directory = false) {
  const base = path.resolve(root), target = path.resolve(file);
  if (!within(base, target)) throw new Error('Transfer target leaves its selected root.');
  const canonical = await realpath(base);
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const value = await info(current);
    if (!value) continue;
    if (value.isSymbolicLink() || !within(canonical, await realpath(current))) throw new Error('Transfer target contains an unsafe link.');
    if (current !== target || directory) {
      if (!value.isDirectory()) throw new Error('Transfer target parent is not a directory.');
    } else if (!value.isFile()) throw new Error('Transfer target is not a regular file.');
  }
  return target;
}

export class ImportTransaction {
  constructor(repo, stateDir, backup) {
    Object.assign(this, { repo, stateDir, backup });
    this.entries = new Map(); this.directories = []; this.external = [];
    this.status = 'preparing'; this.started = false;
  }
  root(file) {
    const roots = [this.repo, ...this.nativeRoots || []].filter(root => within(path.resolve(root), path.resolve(file)));
    if (!roots.length) throw new Error('Unregistered import destination.');
    return roots.sort((a, b) => b.length - a.length)[0];
  }
  async check(file, directory = false) { return transferTarget(this.root(file), file, directory); }
  async initialize(nativeRoots = []) {
    this.nativeRoots = nativeRoots;
    await transferTarget(this.repo, this.stateDir, true);
    const directory = path.dirname(this.backup);
    await transferTarget(this.repo, directory, true);
    for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Import recovery directory contains an unsafe entry.');
      const journal = path.join(directory, item.name, 'transaction.json');
      await transferTarget(this.repo, journal);
      const previous = await readFile(journal, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous && !['committed', 'rolled-back'].includes(JSON.parse(previous).status)) throw new Error(`An interrupted import requires recovery before retrying. Recovery journal: ${journal}`);
    }
  }
  async journal() {
    await transferTarget(this.repo, this.backup, true);
    await mkdir(this.backup, { recursive: true });
    const target = path.join(this.backup, 'transaction.json'), temporary = `${target}.${randomUUID()}.tmp`;
    await transferTarget(this.repo, target);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, status: this.status, entries: [...this.entries.values()], directories: this.directories, external: this.external }, null, 2));
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, target);
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.started = true;
  }
  async parents(file) {
    await this.check(file);
    const missing = [];
    let current = path.dirname(file);
    while (!(await info(current))) { missing.unshift(current); current = path.dirname(current); }
    for (const folder of missing) {
      await this.check(folder, true);
      const entry = { folder, created: false };
      this.directories.push(entry); await this.journal();
      await mkdir(folder); entry.created = true; await this.journal();
    }
  }
  async directory(folder) {
    await this.check(folder, true);
    await this.parents(path.join(folder, '.import-directory-probe'));
  }
  async capture(file) {
    file = path.resolve(file);
    await this.check(file);
    if (this.entries.has(file)) return this.entries.get(file);
    const previous = await info(file);
    const entry = { file, root: this.root(file), before: previous ? await hash(file) : null, after: previous ? await hash(file) : null, backup: null, touched: false };
    if (previous) {
      entry.backup = path.join(this.backup, 'originals', `${this.entries.size}.bin`);
      await transferTarget(this.repo, entry.backup);
      await mkdir(path.dirname(entry.backup), { recursive: true });
      await copyFile(file, entry.backup);
      if (await hash(entry.backup) !== entry.before) throw new Error('Import destination changed while backing up.');
    }
    this.entries.set(file, entry);
    await this.journal();
    return entry;
  }
  async copy(source, file) {
    const entry = await this.capture(file);
    await this.parents(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary, 1);
      const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      const after = await hash(temporary);
      await this.check(file);
      if ((await info(file) ? await hash(file) : null) !== entry.after) throw new Error('Import destination changed before replacement.');
      const oldAfter = entry.after;
      entry.touched = true; entry.after = after; entry.pendingPrevious = oldAfter;
      this.status = 'applying'; await this.journal();
      await rename(temporary, file);
      delete entry.pendingPrevious; await this.journal();
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async json(file, value) {
    await this.check(file);
    const staging = path.join(this.backup, `data-${randomUUID()}.json`);
    await transferTarget(this.repo, staging);
    await mkdir(this.backup, { recursive: true });
    const handle = await open(staging, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); } finally { await handle.close(); }
    try { await this.copy(staging, file); } finally { await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async remove(file) {
    const entry = await this.capture(file);
    if (!await info(file)) return;
    await this.check(file);
    if (await hash(file) !== entry.after) throw new Error('Import destination changed before removal.');
    entry.pendingPrevious = entry.after; entry.after = null; entry.touched = true;
    await this.journal(); await unlink(file); delete entry.pendingPrevious; await this.journal();
  }
  async externalWrite(record) { this.external.push(record); await this.journal(); }
  async commit() {
    const previous = this.status;
    this.status = 'committed';
    try { await this.journal(); } catch (error) { this.status = previous; throw error; }
  }
  async rollback() {
    const errors = [];
    for (const entry of [...this.entries.values()].reverse()) {
      if (!entry.touched) continue;
      try {
        await this.check(entry.file);
        const current = await info(entry.file) ? await hash(entry.file) : null;
        if (current === entry.before) continue;
        if (current !== entry.after && current !== entry.pendingPrevious) throw new Error(`Destination changed; retained for recovery: ${entry.file}`);
        if (entry.before === null) await unlink(entry.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else {
          await transferTarget(this.repo, entry.backup);
          if (await hash(entry.backup) !== entry.before) throw new Error('Import recovery backup changed.');
          const temporary = `${entry.file}.${randomUUID()}.tmp`;
          try { await copyFile(entry.backup, temporary, 1); await this.check(entry.file); await rename(temporary, entry.file); }
          finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        }
      } catch (error) { errors.push(error); }
    }
    for (const { folder, created } of [...this.directories].reverse()) {
      if (!created) continue;
      try { await this.check(folder, true); await rmdir(folder); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) errors.push(error); }
    }
    this.status = errors.length || this.external.length ? 'recovery-required' : 'rolled-back';
    await this.journal();
    if (this.status === 'recovery-required') throw new AggregateError(errors, `Import recovery requires review. Native changes or concurrently modified files were retained. Recovery journal: ${path.join(this.backup, 'transaction.json')}`);
  }
}
