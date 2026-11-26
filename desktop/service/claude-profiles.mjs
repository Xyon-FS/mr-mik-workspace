import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnvironment, claudeBinary } from './agents.mjs';
import { realProfileDirectory } from './codex-profile-layout.mjs';
import { AccountProfiles } from './account-profiles.mjs';
import { saveJson } from './util.mjs';

const execute = promisify(execFile), uuid = /^[a-f0-9-]{36}$/i;
const bad = message => Object.assign(new Error(message), { status: 409 });
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
const label = value => { if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/.test(value)) throw bad('Use a profile name of 1–80 characters.'); return value.trim(); };
async function text(file) {
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) throw bad('Claude profile registry is unavailable.');
  return readFile(file, 'utf8');
}
export async function readClaudeProfileIdentity(env) {
  const binary = claudeBinary(env);
  let output;
  try { output = await execute(binary.file, [...binary.args, 'auth', 'status', '--json'], { env, windowsHide: true, timeout: 12000, maxBuffer: 32768 }); }
  catch (error) { if (error.stdout && typeof error.code === 'number') output = error; else throw bad('Claude account status could not be verified.'); }
  let value; try { value = JSON.parse(output.stdout); } catch { throw bad('Claude account status could not be verified.'); }
  if (value.loggedIn === false) return { status: 'logged-out', identity: null };
  if (value.loggedIn !== true) throw bad('Claude account status could not be verified.');
  const email = typeof value.email === 'string' && value.email.length <= 254 && !/[\x00-\x1f]/.test(value.email) ? value.email : null;
  const account = typeof value.accountId === 'string' ? value.accountId : email;
  return { status: 'logged-in', email, identity: account ? hash(JSON.stringify([value.authMethod || '', account, value.orgId || ''])) : null };
}

// Each directory is an actual native Claude store, never a shadow/copy of another.
export class ClaudeProfiles {
  constructor({ root, env = process.env, home = os.homedir(), identity = readClaudeProfileIdentity } = {}) {
    this.root = path.join(root || path.join(process.env.LOCALAPPDATA || path.join(home, '.local', 'share'), 'MrMik', 'Accounts'), 'Claude');
    Object.assign(this, { env: { ...env }, home, identity });
    // Reuse only native-command reservations, never Codex profile layouts.
    this.actions = new AccountProfiles({ root: this.root, env, home });
  }
  async canonical(folder, create = false) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder)) throw bad('Choose an absolute Claude configuration directory.');
    folder = path.resolve(folder);
    if (folder === path.parse(folder).root || normalize(folder) === normalize(path.resolve(this.home))) throw bad('Choose a dedicated Claude configuration directory.');
    if (create) return realProfileDirectory(folder, true);
    const info = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) return realProfileDirectory(folder);
    return folder;
  }
  async registry() {
    if (await lstat(this.root).catch(() => null)) await realProfileDirectory(this.root);
    const source = await text(path.join(this.root, 'profiles.json'));
    if (!source) return { version: 1, profiles: [] };
    let value; try { value = JSON.parse(source); } catch { throw bad('Claude profile registry is malformed.'); }
    if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 2048 || value.profiles.some(row => !uuid.test(row.id) || typeof row.label !== 'string' || !path.isAbsolute(row.directory || '')) || new Set(value.profiles.map(row => row.id)).size !== value.profiles.length) throw bad('Claude profile registry is invalid.');
    return value;
  }
  async mutate(operation) {
    await realProfileDirectory(this.root, true);
    const file = path.join(this.root, '.registry.lock'), owner = randomUUID();
    try { await writeFile(file, owner, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code === 'EEXIST') throw bad('Another Claude profile change is in progress.'); throw error; }
    try { const registry = await this.registry(), result = await operation(registry); await saveJson(path.join(this.root, 'profiles.json'), registry); return result; }
    finally { if (await text(file) !== owner) throw bad('Claude registry lock changed.'); await unlink(file); }
  }
  accountAction() { return this.actions.accountAction(); }
  reserveAccountAction(id) { return this.actions.reserveAccountAction(id); }
  async list() { return [{ id: 'system', label: 'Claude · current account', system: true }, ...(await this.registry()).profiles.filter(row => !row.removed).map(({ id, label }) => ({ id, label, system: false }))]; }
  async create(name, directory) {
    return this.mutate(async registry => {
      if (registry.profiles.filter(row => !row.removed).length >= 100 || registry.profiles.length >= 2048) throw bad('Claude profile limit reached.');
      const id = randomUUID(), current = await this.context('system');
      const folder = directory ? await this.canonical(directory) : path.join(this.root, 'profiles', id);
      if (directory && !(await lstat(folder).catch(() => null))?.isDirectory()) throw bad('Choose an existing Claude directory or create a new account.');
      const retained = directory && registry.profiles.find(row => row.removed && normalize(row.directory) === normalize(folder));
      if (retained) { retained.removed = false; if (name) retained.label = label(name); return { id: retained.id, label: retained.label, system: false }; }
      const overlaps = (left, right) => { const relative = path.relative(normalize(left), normalize(right)); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
      for (const other of [current.directory, ...registry.profiles.map(row => row.directory)]) if (overlaps(other, folder) || overlaps(folder, other)) throw bad('This directory overlaps an existing Claude profile. Use its existing association.');
      if (!directory) await this.canonical(folder, true);
      const row = { id, label: name ? label(name) : `Claude account ${registry.profiles.length + 1}`, directory: folder, createdAt: new Date().toISOString() };
      registry.profiles.push(row); return { id, label: row.label, system: false };
    });
  }
  rename(id, name) { return this.mutate(registry => { const row = registry.profiles.find(row => row.id === id && !row.removed); if (!row) throw bad('Claude profile is missing.'); row.label = label(name); return { renamed: true }; }); }
  remove(id) { return this.mutate(registry => { const row = registry.profiles.find(row => row.id === id && !row.removed); if (!row) throw bad('Claude profile is missing.'); row.removed = true; return { removed: true, nativeFilesRetained: true }; }); }
  async context(id = 'system', repo) {
    const system = !id || id === 'system', row = system ? null : (await this.registry()).profiles.find(row => row.id === id && !row.removed);
    if (!system && !row) throw bad('This chat’s Claude profile is missing or disconnected. Its original account was not substituted.');
    const directory = await this.canonical(system ? this.env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude') : row.directory);
    if (!system && !(await lstat(directory).catch(() => null))?.isDirectory()) throw bad('The Claude profile directory is missing. Restore it before resuming.');
    const env = childEnvironment(repo, this.env);
    if (!system) {
      for (const name of Object.keys(env)) if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS)|CLAUDE_CODE_(OAUTH_TOKEN|OAUTH_TOKEN_FILE|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)|CLAUDE_SECURESTORAGE_CONFIG_DIR)$/i.test(name)) delete env[name];
      env.CLAUDE_CONFIG_DIR = directory;
    } else if (!this.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
    // HOME/USERPROFILE stay untouched: the CLI owns native secure storage.
    return { agent: 'claude', profileId: id || 'system', label: row?.label || 'Claude · current account', system, directory, sharedHome: directory, conversationStoreId: hash(normalize(directory)), configRevision: hash(normalize(directory)), env };
  }
  async forSession(session, repo = session.cwd) {
    const context = await this.context(session.accountProfileId || 'system', repo);
    if (session.conversationStoreId && session.conversationStoreId !== context.conversationStoreId) throw bad('This chat’s Claude configuration directory changed. Restore the original directory; no conversation was moved.');
    return context;
  }
  async verify(session, context) {
    context ||= await this.forSession(session);
    if (session.conversationStoreId && session.conversationStoreId !== context.conversationStoreId) throw bad('This chat’s Claude configuration directory changed. Restore the original directory; no conversation was moved.');
    const current = await this.identity(context.env);
    if (current.status !== 'logged-in') throw bad('Sign in to this Claude profile in Settings → Accounts before opening its chat.');
    if (session.claudeAccountIdentity && session.claudeAccountIdentity !== current.identity) throw bad('This chat’s Claude account identity changed. Restore its original account before continuing.');
    if (current.identity) session.claudeAccountIdentity = current.identity;
    return current;
  }
}
