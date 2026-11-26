import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, unlink, lstat, realpath } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { saveJson } from './util.mjs';
import { childEnvironment } from './agents.mjs';
import { prepareCodexProfileLayout, inspectCodexProfileLayout, projectCodexProfileConfig, codexProfileEnvironment, realProfileDirectory } from './codex-profile-layout.mjs';
import { linkShadowRuntime } from './codex-shadow-state.mjs';
import { readAccountIdentity } from './account-identity.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const bad = message => Object.assign(new Error(message), { status: 409 });
const label = value => { if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f]/.test(value)) throw bad('Use a profile name of 1–80 characters.'); return value.trim(); };
const safeFile = async file => {
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 1024 * 1024)) throw bad('Profile registry/configuration cannot be read safely.');
  return info ? readFile(file, 'utf8') : null;
};

export class AccountProfiles {
  constructor({ root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'MrMik', 'Accounts'), env = process.env, home = os.homedir() } = {}) {
    Object.assign(this, { root, env: { ...env }, home });
    this.preparing = new Map();
  }
  async system() {
    const home = path.resolve(this.env.CODEX_HOME || path.join(this.home, '.codex'));
    const text = await safeFile(path.join(home, 'config.toml')) || '';
    let config; try { config = parse(text.replace(/^\uFEFF/, '')); } catch { throw bad('System Codex configuration is malformed.'); }
    const configured = config.sqlite_home || this.env.CODEX_SQLITE_HOME || home;
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw bad('Use an absolute system SQLite path before creating shared account profiles.');
    const canonical = folder => realpath(folder).catch(error => { if (error.code === 'ENOENT') return path.resolve(folder); throw error; });
    const [sharedHome, sqliteHome] = await Promise.all([canonical(home), canonical(configured)]);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    return { profileId: 'system', label: 'System / current Codex', sharedHome, privateHome: sharedHome, sqliteHome, conversationStoreId: hash(JSON.stringify([normalize(sharedHome), normalize(sqliteHome)])), configRevision: hash(text), sourceText: text };
  }
  async registry() {
    const rootInfo = await lstat(this.root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!rootInfo) return { version: 1, profiles: [] };
    await realProfileDirectory(this.root);
    const text = await safeFile(path.join(this.root, 'profiles.json'));
    if (text === null) return { version: 1, profiles: [] };
    let value; try { value = JSON.parse(text); } catch { throw bad('Local account profile registry is malformed.'); }
    if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 2048 || value.profiles.filter(item => !item.removed).length > 100 || value.profiles.some(item => !uuid.test(item.id) || typeof item.label !== 'string' || !path.isAbsolute(item.sharedHome || '') || !path.isAbsolute(item.sqliteHome || '')) || new Set(value.profiles.map(item => item.id)).size !== value.profiles.length) throw bad('Local account profile registry is invalid.');
    if (value.profiles.some(item => item.identity != null && (item.identity.version !== 1 || !/^[a-f0-9]{64}$/.test(item.identity.fingerprint || '') || item.identity.email != null && (typeof item.identity.email !== 'string' || item.identity.email.length > 254 || /[\x00-\x1f]/.test(item.identity.email))))) throw bad('Local account identity registry is invalid.');
    return value;
  }
  async list() {
    const registry = await this.registry();
    return [{ id: 'system', label: 'System / current Codex', system: true }, ...registry.profiles.filter(item => !item.removed).map(item => ({ id: item.id, label: item.label, system: false, settingsMode: item.settingsMode }))];
  }
  // Status display must not prepare/migrate every account's runtime layout.
  // Actual chat/account operations still use context() and identity verification.
  async statusContext(profileId) {
    if (!profileId || profileId === 'system') return { ...await this.system(), env: childEnvironment(undefined, this.env), system: true };
    if (!uuid.test(profileId)) throw bad('Invalid account profile reference.');
    const item = (await this.registry()).profiles.find(row => row.id === profileId && !row.removed);
    if (!item) throw bad('Account profile is missing.');
    const privateHome = await realProfileDirectory(path.join(this.root, 'profiles', profileId));
    return { profileId, privateHome, system: false, env: codexProfileEnvironment(childEnvironment(undefined, this.env), privateHome, item.sqliteHome) };
  }
  async mutate(operation) {
    await realProfileDirectory(this.root, true);
    const lock = path.join(this.root, '.registry.lock'), owner = randomUUID();
    try { await writeFile(lock, owner, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code === 'EEXIST') throw bad('Another account profile change is in progress.'); throw error; }
    try {
      const registry = await this.registry(), result = await operation(registry);
      await saveJson(path.join(this.root, 'profiles.json'), registry);
      return result;
    } finally { if (await safeFile(lock) !== owner) throw bad('Account registry lock changed; review it before retrying.'); await unlink(lock); }
  }
  async create(name) {
    if (name) name = label(name);
    return this.mutate(async registry => {
      if (registry.profiles.filter(item => !item.removed).length >= 100) throw bad('The connected account limit is reached. Disconnect an unused account first.');
      if (registry.profiles.length >= 2048) throw bad('The retained account registry is full. Preserve it for review; old chat references must not be deleted automatically.');
      const system = await this.system(), id = randomUUID();
      if (!name) {
        const used = new Set(registry.profiles.filter(item => !item.removed).map(item => item.label));
        let number = 1; while (used.has(`Account ${number}`)) number++;
        name = `Account ${number}`;
      }
      // Profiles share the existing conversation store, never its auth files.
      const layout = await prepareCodexProfileLayout({ privateHome: path.join(this.root, 'profiles', id), sharedHome: system.sharedHome, sqliteHome: system.sqliteHome, sourceText: system.sourceText, common: true });
      const item = { id, label: name, sharedHome: layout.sharedHome, sqliteHome: layout.sqliteHome, createdAt: new Date().toISOString(), settingsMode: 'shared' };
      registry.profiles.push(item);
      return { id, label: name, system: false, settingsMode: item.settingsMode };
    });
  }
  async rename(id, name) {
    name = label(name);
    return this.mutate(registry => { const item = registry.profiles.find(item => item.id === id && !item.removed); if (!item) throw bad('Account profile is missing.'); item.label = name; return { id, label: name }; });
  }
  async remove(id) {
    return this.mutate(registry => { const item = registry.profiles.find(item => item.id === id && !item.removed); if (!item) throw bad('Account profile is missing.'); item.removed = true; return { removed: true, nativeFilesRetained: true }; });
  }
  async identityStates() {
    const profiles = (await this.registry()).profiles.filter(item => !item.removed);
    const states = await Promise.all(profiles.map(async item => {
      try { const home = await realProfileDirectory(path.join(this.root, 'profiles', item.id)); return { item, current: await readAccountIdentity(home) }; }
      catch { return { item, current: null, unreadable: true }; }
    }));
    return states.map(({ item, current, unreadable }) => {
      const duplicate = current && states.find(other => other.item.id !== item.id && other.current?.fingerprint === current.fingerprint);
      const state = unreadable ? 'unreadable' : !current ? 'signed-out' : item.identity && item.identity.fingerprint !== current.fingerprint ? 'changed' : duplicate ? 'duplicate' : !item.identity ? 'unverified' : 'verified';
      return { id: item.id, identityState: state, identityEmail: current?.email || null, duplicateLabel: duplicate?.item.label || null, ...(state === 'unverified' ? { identityRevision: current.fingerprint } : {}) };
    });
  }
  async assertIdentity(id) {
    const state = (await this.identityStates()).find(item => item.id === id);
    if (state?.identityState !== 'verified') throw bad(state?.identityState === 'duplicate' ? 'This ChatGPT account is connected more than once. Resolve the duplicate in Settings → Accounts.' : state?.identityState === 'changed' ? 'This profile’s ChatGPT identity changed unexpectedly. Reconnect it in Settings → Accounts; no message was sent.' : 'Verify or reconnect this Codex account in Settings → Accounts before continuing.');
    return state;
  }
  async bindIdentity(id, { existing = false, expected } = {}) {
    return this.mutate(async registry => {
      const item = registry.profiles.find(item => item.id === id && !item.removed);
      if (!item) throw bad('Account profile is missing.');
      const current = await readAccountIdentity(await realProfileDirectory(path.join(this.root, 'profiles', id)));
      if (!current) throw bad('Codex sign-in did not leave a readable local identity. Reconnect this account.');
      if (expected !== undefined && expected !== current.fingerprint) throw bad('Account identity changed since review. Refresh Accounts and review again.');
      if (existing && item.identity && item.identity.fingerprint !== current.fingerprint) throw bad('Account identity changed. Sign out and reconnect instead of accepting an unexpected identity.');
      for (const other of registry.profiles.filter(row => !row.removed && row.id !== id)) {
        const identity = await readAccountIdentity(await realProfileDirectory(path.join(this.root, 'profiles', other.id)));
        if (identity?.fingerprint === current.fingerprint) throw bad(`This ChatGPT account is already connected as ${other.label}. Sign out the duplicate profile; existing chats are kept.`);
      }
      item.identity = current;
      return { verified: true };
    });
  }
  async accountAction() {
    const file = path.join(this.root, 'codex-account-action.json'), text = await safeFile(file);
    if (text === null) return null;
    let value; try { value = JSON.parse(text); } catch { throw bad('Retained native account action requires review.'); }
    if (typeof value.owner !== 'string' || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.profileId !== 'string') throw bad('Retained native account action requires review.');
    if (value.managedBy !== undefined) {
      if (!Number.isInteger(value.managedBy) || value.managedBy <= 0) throw bad('Retained native account action requires review.');
      // A hidden command can exit before the service finishes its registry
      // transaction. Readers must not remove the live service's reservation.
      try { process.kill(value.managedBy, 0); return { profileId: value.profileId }; }
      catch (error) { if (error.code !== 'ESRCH') return { profileId: value.profileId }; }
    }
    try { process.kill(value.pid, 0); return { profileId: value.profileId }; }
    catch (error) {
      if (error.code !== 'ESRCH') return { profileId: value.profileId };
      if (await safeFile(file) !== text) throw bad('Native account action changed; retry.');
      await unlink(file); return null;
    }
  }
  async reserveAccountAction(profileId) {
    await realProfileDirectory(this.root, true);
    if (await this.accountAction()) throw bad('Finish the native Codex account command in the other window first.');
    const file = path.join(this.root, 'codex-account-action.json');
    let text = JSON.stringify({ owner: randomUUID(), profileId, pid: process.pid });
    try { await writeFile(file, text, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') throw bad('Another native account command is starting.'); throw error; }
    return async (pid, managed = false) => {
      if (await safeFile(file) !== text) throw bad('Native account action ownership changed.');
      if (pid) { text = JSON.stringify({ ...JSON.parse(text), pid, ...(managed ? { managedBy: process.pid } : {}) }); await writeFile(file, text, { mode: 0o600 }); }
      else await unlink(file);
    };
  }
  async upgradeRuntimeLayouts(system, registry) {
    if (this.upgrading) return this.upgrading;
    const pending = (async () => {
      const upgrades = [];
      const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
      const observedRegistry = registry || await this.registry();
      const candidates = observedRegistry.profiles.filter(item => !item.removed && normalize(item.sharedHome) === normalize(system.sharedHome) && normalize(item.sqliteHome) === normalize(system.sqliteHome));
      // Only metadata reads overlap. Every old layout is still preflighted
      // before the first migration, including layouts of unselected accounts.
      const metadata = await Promise.all(candidates.map(item => safeFile(path.join(this.root, 'profiles', item.id, 'profile-layout.json'))));
      for (const [index, item] of candidates.entries()) {
        const privateHome = path.join(this.root, 'profiles', item.id);
        const text = metadata[index];
        if (!text || JSON.parse(text).version === 3) continue;
        // Preflight every old profile before moving any of their runtime state.
        await inspectCodexProfileLayout({ privateHome, sharedHome: item.sharedHome, sqliteHome: item.sqliteHome });
        await linkShadowRuntime(privateHome, item.sharedHome, JSON.parse(text), { dryRun: true });
        upgrades.push({ ...item, privateHome });
      }
      if (upgrades.length) await this.beforeMigration?.();
      if (upgrades.length && (this.migrationBusy?.() || await this.accountAction())) throw bad('Close Codex chats and finish account commands before upgrading shared runtime state. Existing chats have not been restarted.');
      if (upgrades.length) {
        const current = await Promise.all(candidates.map(item => safeFile(path.join(this.root, 'profiles', item.id, 'profile-layout.json'))));
        if (current.some((text, index) => text !== metadata[index])) throw bad('Codex profile layouts changed during migration preflight. Retry before starting a chat.');
        if (hash(JSON.stringify(await this.registry())) !== hash(JSON.stringify(observedRegistry))) throw bad('Codex account registry changed during migration preflight. Retry before starting a chat.');
      }
      for (const item of upgrades) await prepareCodexProfileLayout({ privateHome: item.privateHome, sharedHome: item.sharedHome, sqliteHome: item.sqliteHome, sourceText: system.sourceText, common: true, validateSource: () => this.validatePreparation(system, observedRegistry) });
    })();
    this.upgrading = pending;
    try { return await pending; } finally { if (this.upgrading === pending) this.upgrading = null; }
  }
  async validatePreparation(system, registry) {
    const [currentSystem, currentRegistry] = await Promise.all([this.system(), this.registry()]);
    if (currentSystem.configRevision !== system.configRevision || currentSystem.conversationStoreId !== system.conversationStoreId || hash(JSON.stringify(currentRegistry)) !== hash(JSON.stringify(registry))) throw bad('Codex account or configuration changed while preparing its layout. Retry opening the chat.');
  }
  async assertCurrentContext(context) {
    const [system, current, instructions] = await Promise.all([
      this.system(), safeFile(path.join(context.privateHome, 'config.toml')),
      Promise.all(['AGENTS.md', 'AGENTS.override.md'].map(name => Promise.all([safeFile(path.join(context.privateHome, name)), safeFile(path.join(context.sharedHome, name))]))),
    ]);
    const expected = projectCodexProfileConfig(system.sourceText, context.sqliteHome, { commonHome: context.sharedHome });
    if (system.conversationStoreId !== context.conversationStoreId || current === null || hash(current) !== context.configRevision || hash(expected) !== context.configRevision || hash(JSON.stringify(instructions.map(([local]) => local))) !== context.instructionsRevision || instructions.some(([local, shared]) => local !== shared)) throw bad('Codex configuration changed during startup. Reopen this chat to load the current tools and instructions.');
  }
  async inspectContext(profileId, repo, { verifyIdentity = true, registryRevision } = {}) {
    if (!uuid.test(profileId || '') || this.upgrading || this.preparing.size || await this.accountAction()) return null;
    const registry = await this.registry();
    if (registryRevision && registryRevision !== hash(JSON.stringify(registry))) return null;
    const item = registry.profiles.find(item => item.id === profileId && !item.removed);
    if (!item) return null;
    const system = await this.system();
    if (await safeFile(path.join(this.root, 'profiles', profileId, '.mr-mik-layout.lock')) !== null) return null;
    const layout = await inspectCodexProfileLayout({ privateHome: path.join(this.root, 'profiles', profileId), sharedHome: item.sharedHome, sqliteHome: item.sqliteHome });
    if (!layout.sharedDirectories.includes('logs')) return null;
    if (layout.conversationStoreId !== system.conversationStoreId) return null;
    // Speculation cannot rewrite or migrate stale native profile layouts.
    const expected = projectCodexProfileConfig(system.sourceText, item.sqliteHome, { commonHome: item.sharedHome });
    const current = await safeFile(path.join(layout.privateHome, 'config.toml'));
    if (current !== expected) return null;
    const metadata = JSON.parse(await safeFile(path.join(layout.privateHome, 'profile-layout.json')));
    if (metadata.sourceHash !== hash(system.sourceText) || metadata.configHash !== hash(current)) return null;
    const instructions = await Promise.all(['AGENTS.md', 'AGENTS.override.md'].map(async name => Promise.all([safeFile(path.join(layout.privateHome, name)), safeFile(path.join(layout.sharedHome, name))])));
    if (instructions.some(([privateText, sharedText]) => privateText !== sharedText)) return null;
    if (await safeFile(path.join(layout.privateHome, '.mr-mik-layout.lock')) !== null) return null;
    if (verifyIdentity) await this.assertIdentity(profileId);
    return { ...layout, profileId, label: item.label, system: false, instructionsRevision: hash(JSON.stringify(instructions.map(([local]) => local))), env: codexProfileEnvironment(childEnvironment(repo, this.env), layout.privateHome, layout.sqliteHome) };
  }
  async context(profileId = 'system', repo) {
    if (!profileId || profileId === 'system') { const system = await this.system(); return { ...system, env: childEnvironment(repo, this.env), system: true }; }
    if (!uuid.test(profileId)) throw bad('Invalid account profile reference.');
    const registry = await this.registry();
    const item = registry.profiles.find(item => item.id === profileId && !item.removed);
    if (!item) throw bad('This chat’s account profile is missing. Choose an available profile explicitly; the current account was not substituted.');
    const system = await this.system();
    if (system.conversationStoreId !== hash(JSON.stringify([process.platform === 'win32' ? item.sharedHome.toLowerCase() : item.sharedHome, process.platform === 'win32' ? item.sqliteHome.toLowerCase() : item.sqliteHome]))) throw bad('The common Codex home changed. Restore it before using this account.');
    await this.upgradeRuntimeLayouts(system, registry);
    // An unchanged, fully inspected layout needs no write lock or synchronization.
    // Stale source/instructions, incomplete layouts and concurrent writers still
    // use the original serialized preparation path below.
    let inspected;
    try { inspected = await this.inspectContext(profileId, repo, { verifyIdentity: false, registryRevision: hash(JSON.stringify(registry)) }); }
    catch { /* The original preparation path below owns recovery and validation errors. */ }
    if (inspected) return inspected;
    // Recovery crosses an asynchronous inspection/migration boundary. Do not
    // repair a removed profile or project an older common configuration over
    // settings edited while that work was running.
    const previous = this.preparing.get(profileId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const latestRegistry = await this.registry(), latestItem = latestRegistry.profiles.find(item => item.id === profileId && !item.removed);
      if (!latestItem) throw bad('This chat’s account profile is missing. Choose an available profile explicitly; the current account was not substituted.');
      const latestSystem = await this.system();
      if (latestSystem.conversationStoreId !== hash(JSON.stringify([process.platform === 'win32' ? latestItem.sharedHome.toLowerCase() : latestItem.sharedHome, process.platform === 'win32' ? latestItem.sqliteHome.toLowerCase() : latestItem.sqliteHome]))) throw bad('The common Codex home changed. Restore it before using this account.');
      await this.upgradeRuntimeLayouts(latestSystem, latestRegistry);
      const layout = await prepareCodexProfileLayout({ privateHome: path.join(this.root, 'profiles', profileId), sharedHome: latestItem.sharedHome, sqliteHome: latestItem.sqliteHome, sourceText: latestSystem.sourceText, common: true, validateSource: () => this.validatePreparation(latestSystem, latestRegistry) });
      const instructions = await Promise.all(['AGENTS.md', 'AGENTS.override.md'].map(name => safeFile(path.join(layout.privateHome, name))));
      return { ...layout, profileId, label: latestItem.label, system: false, instructionsRevision: hash(JSON.stringify(instructions)), env: codexProfileEnvironment(childEnvironment(repo, this.env), layout.privateHome, layout.sqliteHome) };
    });
    this.preparing.set(profileId, pending);
    try { return await pending; } finally { if (this.preparing.get(profileId) === pending) this.preparing.delete(profileId); }
  }
}
