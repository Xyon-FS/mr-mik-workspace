import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';
import { linkShadowRuntime, shadowRuntimeDirectories } from './codex-shadow-state.mjs';

// Sharing a conversation store is intentional data sharing, not account privacy.
const sharedDirectories = ['sessions', 'archived_sessions'];
const commonDirectories = [...sharedDirectories, 'skills', 'plugins'];
const commonInstructionFiles = ['AGENTS.md', 'AGENTS.override.md'];
const privateEntries = ['auth.json', 'models_cache.json', 'config.toml', 'profile-layout.json'];
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(`Codex profile layout: ${code}. No native account was changed.`), { code });
const info = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const nested = (a, b) => { const relative = path.relative(a, b); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

export async function realProfileDirectory(folder, create = false) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw fail('absolute-path-required');
  const target = path.resolve(folder), parents = [];
  for (let current = target; ; current = path.dirname(current)) {
    parents.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const parent of parents) {
    let entry = await info(parent);
    if (!entry && create) { await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); entry = await info(parent); }
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw fail('directory-conflict');
  }
  return realpath(target);
}

async function regularText(file, optional = false) {
  const entry = await info(file);
  if (!entry && optional) return null;
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink > 1) throw fail('private-file-conflict');
  if (entry.size > 1024 * 1024) throw fail('configuration-too-large');
  return readFile(file, 'utf8');
}

// Start with a small, reviewed schema, not arbitrary recursive path guessing.
// Unsupported configuration is a compatibility result, never silently dropped.
const scalarKeys = new Set(['model', 'model_provider', 'model_reasoning_effort', 'model_verbosity', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'disable_response_storage', 'web_search', 'personality', 'developer_instructions', 'instructions', 'check_for_update_on_startup', 'cli_auth_credentials_store', 'sqlite_home']);
const tableKeys = new Set(['projects', 'mcp_servers', 'plugins', 'skills', 'features', 'sandbox_workspace_write', 'shell_environment_policy']);
const allowed = (table, keys) => {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw fail('unsupported-configuration');
  if (Object.keys(table).some(key => !keys.includes(key))) throw fail('unsupported-configuration');
};
const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw fail('relative-configuration-path');
  return value;
};

export function projectCodexProfileConfig(sourceText, sqliteHome, { commonHome } = {}) {
  absolute(sqliteHome);
  if (Buffer.byteLength(sourceText, 'utf8') > 1024 * 1024) throw fail('configuration-too-large');
  let config;
  try { config = parse(sourceText.replace(/^\uFEFF/, '')); } catch { throw fail('malformed-configuration'); }
  if (commonHome) {
    absolute(commonHome);
    // Keep native settings intact. Resolve the path fields of the supported
    // native schema against the original layer, never against the shadow home.
    const resolve = value => typeof value === 'string' && !value.startsWith('~') ? path.resolve(commonHome, value) : value;
    const layer = value => {
      for (const key of ['model_instructions_file', 'experimental_compact_prompt_file', 'js_repl_node_path', 'sqlite_home', 'log_dir', 'model_catalog_json']) if (value[key]) value[key] = resolve(value[key]);
      if (value.js_repl_node_module_dirs) value.js_repl_node_module_dirs = value.js_repl_node_module_dirs.map(resolve);
      for (const server of Object.values(value.mcp_servers || {})) if (server.cwd) server.cwd = resolve(server.cwd);
      for (const skill of value.skills?.config || []) if (skill.path) skill.path = resolve(skill.path);
      for (const role of Object.values(value.agents || {})) if (role && typeof role === 'object' && role.config_file) role.config_file = resolve(role.config_file);
      if (value.sandbox_workspace_write?.writable_roots) value.sandbox_workspace_write.writable_roots = value.sandbox_workspace_write.writable_roots.map(resolve);
      for (const profile of Object.values(value.profiles || {})) layer(profile);
    };
    layer(config);
  } else {
    for (const key of Object.keys(config)) if (!scalarKeys.has(key) && !tableKeys.has(key)) throw fail('unsupported-configuration');
  }
  // Keyring/ephemeral/managed requirements need their own proof. Do not override
  // a configured credential policy in order to make this experiment work.
  if (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== 'file') throw fail('unsupported-credential-store');
  if (config.sqlite_home && !same(path.resolve(absolute(config.sqlite_home)), path.resolve(sqliteHome))) throw fail('sqlite-store-conflict');
  if (!commonHome) {
    for (const [folder, trust] of Object.entries(config.projects || {})) { absolute(folder); allowed(trust, ['trust_level']); }
    for (const plugin of Object.values(config.plugins || {})) {
      allowed(plugin, ['enabled']);
      // Plugin install/registration semantics under another home are a separate
      // gate. Do not pretend an enabled plugin exists in this minimal overlay.
      if (plugin.enabled !== false) throw fail('shared-plugin-layout-unverified');
    }
    if (config.skills) {
      allowed(config.skills, ['config']);
      if (!Array.isArray(config.skills.config)) throw fail('unsupported-configuration');
      for (const skill of config.skills.config) { allowed(skill, ['path', 'enabled']); absolute(skill.path); }
    }
    for (const server of Object.values(config.mcp_servers || {})) {
      allowed(server, ['enabled', 'command', 'args', 'env', 'env_vars', 'cwd', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools', 'required']);
      if (server.cwd) absolute(server.cwd);
      if (server.command && /[\\/]/.test(server.command) && !path.isAbsolute(server.command)) throw fail('relative-configuration-path');
    }
    if (config.sandbox_workspace_write) {
      allowed(config.sandbox_workspace_write, ['writable_roots', 'network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp']);
      for (const folder of config.sandbox_workspace_write.writable_roots || []) absolute(folder);
    }
  }
  config.cli_auth_credentials_store = 'file';
  config.sqlite_home = sqliteHome;
  return '# Generated from common Codex settings. Manage shared tools in Mr. Mik Tools.\n' + stringify(config);
}

// Do not let ambient API/token credentials silently select a different account.
// OS HOME/USERPROFILE and all unrelated tool configuration keep their meaning.
export function codexProfileEnvironment(base, privateHome, sqliteHome) {
  absolute(privateHome); absolute(sqliteHome);
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|ACCESS_TOKEN|OPENAI_BASE_URL|CODEX_INTERNAL_ORIGINATOR_OVERRIDE|CODEX_HOME|CODEX_SQLITE_HOME)$/i.test(key)) delete env[key];
  env.CODEX_HOME = privateHome; env.CODEX_SQLITE_HOME = sqliteHome;
  return env;
}

// Installed Codex 0.162.1 can fail when two processes first initialize the same
// SQLite store. Hold this cross-process lease until native initialization has
// succeeded. It is NOT a conversation writer lease or an external CLI lock.
// A crashed owner's lock is retained for review rather than guessed stale.
export async function withCodexStoreStartup(sqliteHome, operation, { timeoutMs = 15000, isCancelled = () => false } = {}) {
  const root = await realProfileDirectory(sqliteHome, true);
  const lock = path.join(root, '.mr-mik-startup.lock'), value = randomUUID(), started = Date.now();
  for (;;) {
    if (isCancelled()) throw fail('startup-cancelled');
    try { await writeFile(lock, value, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) throw fail('conversation-store-startup-busy');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { if (isCancelled()) throw fail('startup-cancelled'); return await operation(); }
  finally {
    if (await regularText(lock) !== value) throw fail('startup-lock-replaced');
    await unlink(lock);
  }
}

// Reopen an owned acceptance layout without regenerating configuration, reading
// authentication contents or changing native model/trust choices made since.
export async function inspectCodexProfileLayout({ privateHome, sharedHome, sqliteHome }) {
  const [home, shared, sqlite] = await Promise.all([privateHome, sharedHome, sqliteHome].map(folder => realProfileDirectory(folder)));
  if (nested(home, shared) || nested(shared, home) || nested(home, sqlite) || nested(sqlite, home)) throw fail('overlapping-homes');
  await Promise.all(privateEntries.map(async name => {
    const entry = await info(path.join(home, name));
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1)) throw fail('private-file-conflict');
  }));
  let config;
  const [configText, metadata] = await Promise.all([
    regularText(path.join(home, 'config.toml')),
    regularText(path.join(home, 'profile-layout.json')).then(text => JSON.parse(text)).catch(() => { throw fail('layout-metadata-conflict'); }),
  ]);
  try {
    config = parse(configText.replace(/^\uFEFF/, ''));
  } catch { throw fail('layout-metadata-conflict'); }
  if (![1, 2, 3].includes(metadata.version) || metadata.sharedHome !== shared || metadata.sqliteHome !== sqlite) throw fail('layout-store-conflict');
  // Inspect the current file instead of enforcing its creation hash: native
  // model and trust edits are legitimate. Identity/storage changes are not.
  if (config.cli_auth_credentials_store !== 'file' || config.profile || typeof config.sqlite_home !== 'string' || !path.isAbsolute(config.sqlite_home) || !same(await realProfileDirectory(config.sqlite_home), sqlite)) throw fail('layout-store-conflict');
  const directories = metadata.version >= 2 ? [...commonDirectories, ...(metadata.version >= 3 ? shadowRuntimeDirectories : [])] : sharedDirectories;
  await Promise.all(directories.map(async name => {
    const [target, entry] = await Promise.all([realProfileDirectory(path.join(shared, name)), info(path.join(home, name))]);
    if (!entry?.isSymbolicLink() || !same(await realpath(path.join(home, name)), target)) throw fail('shared-directory-conflict');
  }));
  const storeId = digest(JSON.stringify([process.platform === 'win32' ? shared.toLowerCase() : shared, process.platform === 'win32' ? sqlite.toLowerCase() : sqlite]));
  return { agent: 'codex', privateHome: home, sharedHome: shared, sqliteHome: sqlite, conversationStoreId: storeId, configRevision: digest(configText), sharedDirectories: [...directories] };
}

export async function prepareCodexProfileLayout({ privateHome, sharedHome, sqliteHome, sourceText = '', common = false, validateSource }) {
  // Validate distinct paths BEFORE creating anything. Nested homes could place
  // private auth in the shared tree, or link transcripts back into themselves.
  for (const folder of [privateHome, sharedHome, sqliteHome]) absolute(folder);
  if (nested(path.resolve(privateHome), path.resolve(sharedHome)) || nested(path.resolve(sharedHome), path.resolve(privateHome)) || nested(path.resolve(privateHome), path.resolve(sqliteHome)) || nested(path.resolve(sqliteHome), path.resolve(privateHome))) throw fail('overlapping-homes');
  const configText = projectCodexProfileConfig(sourceText, path.resolve(sqliteHome), common ? { commonHome: sharedHome } : {});
  const directories = common ? commonDirectories : sharedDirectories;
  const shared = await realProfileDirectory(sharedHome, true);
  const sqlite = await realProfileDirectory(sqliteHome, true);
  const home = await realProfileDirectory(privateHome, true);
  // wx also prevents two managed writers from preparing the same profile.
  const lock = path.join(home, '.mr-mik-layout.lock');
  const lockValue = randomUUID();
  const lockStarted = Date.now();
  for (;;) {
    try { await writeFile(lock, lockValue, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!common || Date.now() - lockStarted > 2000) throw fail('profile-busy');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  let runtimeLinks, committed = false;
  try {
    // Waiting for the filesystem lock is another freshness boundary. A queued
    // app preparation must revalidate its source before writing profile state.
    await validateSource?.();
    for (const name of privateEntries) {
      const entry = await info(path.join(home, name));
      if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1)) throw fail('private-file-conflict');
    }
    let metadata = null;
    const metadataText = await regularText(path.join(home, 'profile-layout.json'), true);
    if (metadataText !== null) {
      try { metadata = JSON.parse(metadataText); } catch { throw fail('layout-metadata-conflict'); }
      if (![1, 2, 3].includes(metadata.version) || metadata.sharedHome !== shared || metadata.sqliteHome !== sqlite) throw fail('layout-store-conflict');
    }
    const current = await regularText(path.join(home, 'config.toml'), true);
    if ((!metadata && current !== null) || (metadata && current === null)) throw fail('external-configuration-edit');
    const edited = metadata && metadata.configHash !== digest(current);
    if (edited && !common) throw fail('external-configuration-edit');
    // Retain native/private edits during migration; the common layer is the
    // source of truth and no private setting is ever copied into the real home.
    if (common && current !== null && current !== configText && (edited || metadata?.version === 1)) await writeFile(path.join(home, `config-retained-${randomUUID()}.toml`), current, { flag: 'wx', mode: 0o600 });
    // Preflight ALL directory entries before creating any links.
    for (const name of directories) {
      await realProfileDirectory(path.join(shared, name), true);
      const entry = await info(path.join(home, name));
      if (entry && !entry.isSymbolicLink() && entry.isDirectory() && common && metadata && metadata.version < 3 && !sharedDirectories.includes(name)) {
        // Preserve old profile resources without merging or deleting them.
        await rename(path.join(home, name), path.join(home, `${name}-retained-${randomUUID()}`));
      } else if (entry && (!entry.isSymbolicLink() || !same(await realpath(path.join(home, name)), await realpath(path.join(shared, name))))) throw fail('shared-directory-conflict');
    }
    for (const name of directories) if (!await info(path.join(home, name))) await symlink(path.join(shared, name), path.join(home, name), process.platform === 'win32' ? 'junction' : 'dir');
    if (common) runtimeLinks = await linkShadowRuntime(home, shared, metadata);
    if (common) for (const name of commonInstructionFiles) {
      const source = await regularText(path.join(shared, name), true);
      const destination = path.join(home, name), local = await regularText(destination, true);
      if (source === local) continue;
      if (local !== null) await writeFile(path.join(home, `${name}-retained-${randomUUID()}`), local, { flag: 'wx', mode: 0o600 });
      if (source === null) { await unlink(destination); continue; }
      const temporary = path.join(home, `.instructions-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
        if (await regularText(destination, true) !== local) throw fail('external-instructions-edit');
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    // A source revision change is explicit input at a safe launch boundary.
    // Existing native edits never get merged, replaced or written back silently.
    if (current !== configText) {
      const temporary = path.join(home, `.config-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, configText, { flag: 'wx', mode: 0o600 });
        if (await regularText(path.join(home, 'config.toml'), true) !== current) throw fail('external-configuration-edit');
        await rename(temporary, path.join(home, 'config.toml'));
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    // A crash between config and metadata writes fails closed on the next run.
    const nextMetadata = JSON.stringify({ version: common ? 3 : 1, sharedHome: shared, sqliteHome: sqlite, sourceHash: digest(sourceText), configHash: digest(configText) }) + '\n';
    if (metadataText !== nextMetadata) await writeFile(path.join(home, 'profile-layout.json'), nextMetadata, { mode: 0o600 });
    committed = true; await runtimeLinks?.commit();
    const storeId = digest(JSON.stringify([process.platform === 'win32' ? shared.toLowerCase() : shared, process.platform === 'win32' ? sqlite.toLowerCase() : sqlite]));
    return { agent: 'codex', privateHome: home, sharedHome: shared, sqliteHome: sqlite, conversationStoreId: storeId, configRevision: digest(configText), sharedDirectories: [...directories, ...(common ? shadowRuntimeDirectories : [])] };
  } catch (error) { if (!committed) await runtimeLinks?.rollback(); throw error;
  } finally {
    // Never remove a replaced lock or follow its link.
    if (await regularText(lock) !== lockValue) throw fail('layout-lock-replaced');
    await unlink(lock);
  }
}
