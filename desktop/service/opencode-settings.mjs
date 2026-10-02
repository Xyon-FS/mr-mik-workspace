import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { saveJson, within } from './util.mjs';
import { configView, hasV2Config, openCodeServers, skillSetting, skillRules, safeInheritedV2Server } from './opencode-config-view.mjs';
import { openCodeVersion } from './opencode.mjs';
import { discoverV2Skills, configurableSkillId, publicV2Skills } from './opencode-v2-skills.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const bad = message => Object.assign(new Error(message), { status: 400 });
const nameOK = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(name) && !['__proto__', 'constructor', 'prototype', 'mrmak_workspace'].includes(name);
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export const openCodeConfigDir = ({ home = os.homedir(), env = process.env } = {}) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
export function mergeOpenCode(base, next) {
  const result = { ...object(base) };
  for (const [key, value] of Object.entries(object(next))) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeOpenCode(result[key], value) : value;
  return result;
}
export async function openCodeDocument(file) {
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { file, source: null, value: {} };
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw bad('OpenCode configuration must be a regular file smaller than 8 MB.');
  const source = await readFile(file, 'utf8'), errors = [];
  const value = parse(source.replace(/^\uFEFF/, ' '), errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw bad('OpenCode configuration is invalid. Repair its JSON/JSONC before changing it.');
  return { file, source, value };
}

// File inventory, not a claim about the CLI's live merged/managed configuration.
export async function openCodeLayers(root, options = {}) {
  const env = options.env || process.env, global = openCodeConfigDir(options), layers = [];
  const add = async (file, scope, priority) => { const doc = await openCodeDocument(file); if (doc.source !== null) layers.push({ ...doc, scope, priority }); };
  for (const [index, name] of ['config.json', 'opencode.json', 'opencode.jsonc'].entries()) await add(path.join(global, name), 'global', 10 + index);
  if (env.OPENCODE_CONFIG) await add(path.resolve(env.OPENCODE_CONFIG), 'custom', 15);
  if (root) for (const [index, name] of ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].entries()) await add(path.join(root, name), 'project', 20 + index);
  if (env.OPENCODE_CONFIG_DIR) for (const [index, name] of ['opencode.json', 'opencode.jsonc'].entries()) await add(path.join(env.OPENCODE_CONFIG_DIR, name), 'custom', 30 + index);
  return layers;
}

export class OpenCodeSettings {
  constructor(projects, stateDir, { home = os.homedir(), env = process.env, family } = {}) { Object.assign(this, { projects, stateDir, home, env, family }); this.pending = Promise.resolve(); this.pluginIdentities = new Map(); }
  observePlugins(root, rows) {
    if (!Array.isArray(rows) || rows.length > 512) throw bad('Native plugin inventory is invalid.');
    const key = path.resolve(root).toLowerCase(), known = this.pluginIdentities.get(key) || new Map();
    for (const row of rows) if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(row.id || '') && !row.id.startsWith('mr-mik') && ['local', 'package'].includes(row.source?.type) && row.status === 'active') {
      const value = row.source.type === 'local' ? row.source.path : row.source.target;
      if (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value) || row.source.type === 'package' && /https?:.*[?@#]/i.test(value)) continue;
      known.set(row.id, { id: row.id, source: row.source.type === 'local' ? { type: 'local', path: value } : { type: 'package', target: value } });
    }
    this.pluginIdentities.set(key, known);
  }
  async pluginRows(state) {
    const key = path.resolve(state.root || this.projects.repo || this.home).toLowerCase();
    const known = this.pluginIdentities.get(key) || new Map();
    const directives = selected => selected.flatMap(layer => Array.isArray(layer.value.plugins) ? layer.value.plugins : []);
    const excludes = (selected, id) => directives(selected).some(value => typeof value === 'string' && value.startsWith('-') && new RegExp(`^${value.slice(1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(id));
    const globalFolder = await realpath(openCodeConfigDir(this)).catch(() => openCodeConfigDir(this));
    return Promise.all([...known.values()].map(async item => {
      const global = state.layers.filter(layer => layer.scope === 'global'), local = state.layers.filter(layer => layer.scope === 'project');
      const localPath = item.source.type === 'local' && typeof item.source.path === 'string' ? await realpath(item.source.path).catch(() => item.source.path) : null;
      const globalSource = localPath ? within(globalFolder, localPath) : global.some(layer => (layer.value.plugins || []).some(value => (typeof value === 'string' ? value : value?.package) === item.source.target));
      return { kind: 'plugin', id: item.id, name: item.id, source: 'Verified native V2 identity', installed: true, globalEnabled: !excludes(global, item.id), globalOverride: directives(global).includes(`-${item.id}`) ? false : null, projectOverride: directives(local).includes(`-${item.id}`) ? false : null,
        effective: !excludes(state.layers, item.id), globalEditable: !state.locked && globalSource, projectEditable: !state.locked && !!state.root, projectDefined: !globalSource,
        note: 'Verified in an open V2 chat. Off adds an exact native ID directive. On/Inherit removes that directive here; inherited wildcard/global exclusions require editing their source. Identity proof is not exported or persisted.' };
    }));
  }
  async state(projectId, repositoryId) {
    const root = projectId ? await this.projects.root(projectId, repositoryId) : null;
    const layers = await openCodeLayers(root, this);
    let family = this.family || (layers.some(layer => hasV2Config(layer.value)) ? 2 : null);
    if (!family) { try { family = Number(openCodeVersion(this.env).split('.')[0]) >= 2 ? 2 : 1; } catch { family = 1; } }
    const globalLayers = layers.filter(layer => layer.scope === 'global');
    const localLayers = layers.filter(layer => layer.scope === 'project');
    const combine = selected => selected.reduce((result, layer) => {
      const view = configView(layer.value, family), next = mergeOpenCode(result, view);
      if (family === 2) next.mcp = { ...object(result.mcp), ...view.mcp };
      return next;
    }, {});
    const merged = combine(layers), global = combine(globalLayers), local = combine(localLayers);
    for (const layer of layers) {
      if (layer.value.mcp != null && (typeof layer.value.mcp !== 'object' || Array.isArray(layer.value.mcp))) throw bad('OpenCode MCP configuration has an invalid object.');
      if (layer.value.permission != null && typeof layer.value.permission !== 'string' && (typeof layer.value.permission !== 'object' || Array.isArray(layer.value.permission))) throw bad('OpenCode permissions have an invalid format.');
      if (layer.value.permission?.skill != null && typeof layer.value.permission.skill !== 'string' && (typeof layer.value.permission.skill !== 'object' || Array.isArray(layer.value.permission.skill))) throw bad('OpenCode skill permissions have an invalid format.');
      skillRules(layer.value);
      for (const definition of Object.values(openCodeServers(layer.value))) if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw bad('OpenCode MCP definition has an invalid format.');
    }
    const globalFile = globalLayers.at(-1)?.file || path.join(openCodeConfigDir(this), 'opencode.json');
    const projectFile = localLayers.at(-1)?.file || (root ? path.join(root, 'opencode.json') : null);
    // Higher-priority runtime/custom settings cannot be safely overridden here.
    const locked = !!(this.env.OPENCODE_CONFIG || this.env.OPENCODE_CONFIG_DIR || this.env.OPENCODE_CONFIG_CONTENT);
    return { root, layers, global, local, merged, globalFile, projectFile, locked, family };
  }
  async skills(state) {
    if (state.family === 2) {
      const folders = [], add = (root, scope) => { for (const name of ['skill', 'skills']) folders.push([path.join(root, name), scope]); };
      for (const root of [openCodeConfigDir(this), path.join(this.home, '.claude'), path.join(this.home, '.agents')]) add(root, 'global');
      if (state.root) {
        const roots = []; let folder = state.root;
        while (true) { roots.unshift(folder); if (await lstat(path.join(folder, '.git')).catch(() => null) || path.dirname(folder) === folder) break; folder = path.dirname(folder); }
        for (const root of roots) for (const prefix of ['.claude', '.agents', '.opencode']) add(path.join(root, prefix), 'project');
      }
      // Native V2 resolves relative sources against the working location,
      // including sources declared in a global document.
      const location = state.root || this.projects.repo || this.home;
      for (const layer of state.layers) for (const source of Array.isArray(layer.value.skills) ? layer.value.skills : []) {
        if (typeof source !== 'string' || /^https?:/i.test(source)) continue;
        folders.push([path.resolve(location, source.replace(/^~(?=[\\/])/, this.home)), layer.scope]);
      }
      const local = await discoverV2Skills(folders), byId = new Map(local.map(row => [row.id, row]));
      if (this.inspectSkills) {
        const native = await this.inspectSkills(location);
        if (native) for (const row of publicV2Skills(native)) {
          const previous = byId.get(row.id);
          byId.set(row.id, { kind: 'skill', id: row.id, name: row.name, source: row.path, installed: true, originScope: previous?.source === row.path ? previous.originScope : 'native', nativeVerified: true });
        }
      }
      return [...byId.values()];
    }
    const found = new Map(), folders = [];
    for (const prefix of ['.claude', '.agents']) folders.push([path.join(this.home, prefix, 'skills'), 'global']);
    folders.push([path.join(openCodeConfigDir(this), 'skills'), 'global']);
    for (const layer of state.layers) {
      const configured = Array.isArray(layer.value.skills) ? layer.value.skills : layer.value.skills?.paths || [];
      for (const folder of configured) if (typeof folder === 'string' && !/^https?:/i.test(folder)) folders.push([path.resolve(path.dirname(layer.file), folder.replace(/^~(?=[\\/])/, this.home)), layer.scope]);
    }
    if (state.root) {
      // Native discovery walks ancestors. Stop at the nearest Git directory;
      // the selected folder still works without Git and is the only edit target.
      const roots = []; let folder = state.root;
      while (true) { roots.unshift(folder); if (await lstat(path.join(folder, '.git')).catch(() => null) || path.dirname(folder) === folder) break; folder = path.dirname(folder); }
      for (const root of roots) for (const prefix of ['.claude', '.agents', '.opencode']) folders.push([path.join(root, prefix, 'skills'), 'project']);
    }
    for (const [folder, scope] of folders) for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name, 'SKILL.md'), info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) continue;
      if (!within(await realpath(folder), await realpath(file))) continue;
      const text = await readFile(file, 'utf8');
      const name = /^name:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim();
      if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
      found.set(name, { kind: 'skill', id: name, name, source: file, originScope: scope, installed: true });
    }
    return [...found.values()];
  }
  async list(projectId = null, repositoryId = null) {
    const state = await this.state(projectId, repositoryId), rows = [];
    if (state.family === 2 && this.inspectPlugins) await this.inspectPlugins(state.root || this.projects.repo);
    for (const [id, definition] of Object.entries(object(state.merged.mcp))) {
      const globalDefined = Object.hasOwn(object(state.global.mcp), id), projectDefined = Object.hasOwn(object(state.local.mcp), id);
      rows.push({ kind: 'mcp', id, name: id, source: state.layers.filter(layer => Object.hasOwn(openCodeServers(layer.value), id)).at(-1)?.file || '', globalEnabled: state.global.mcp?.[id]?.enabled !== false,
        globalOverride: typeof state.global.mcp?.[id]?.enabled === 'boolean' ? state.global.mcp[id].enabled : null,
        projectOverride: typeof state.local.mcp?.[id]?.enabled === 'boolean' ? state.local.mcp[id].enabled : null,
        effective: definition.enabled !== false, projectDefined, globalEditable: globalDefined && !state.locked && nameOK(id), projectEditable: !!state.root && !state.locked && nameOK(id), installed: true });
    }
    for (const skill of await this.skills(state)) rows.push({ ...skill, globalEnabled: skillSetting(state.layers.filter(layer => layer.scope === 'global'), skill.id) !== false, globalOverride: skillSetting(state.layers.filter(layer => layer.scope === 'global'), skill.id, true), effective: skillSetting(state.layers, skill.id) !== false,
      permissionEffect: skillSetting(state.layers, skill.id, false, true) || 'ask', requiresApproval: (skillSetting(state.layers, skill.id, false, true) || 'ask') === 'ask',
      projectOverride: skillSetting(state.layers.filter(layer => layer.scope === 'project'), skill.id, true),
      projectDefined: skill.originScope === 'project', globalEditable: !state.locked, projectEditable: !!state.root && !state.locked });
    if (state.family === 2) rows.push(...await this.pluginRows(state));
    const plugins = [...new Set(state.layers.flatMap(layer => [...(Array.isArray(layer.value.plugin) ? layer.value.plugin : []), ...(Array.isArray(layer.value.plugins) ? layer.value.plugins.map(value => typeof value === 'string' ? value : value?.package) : [])]))];
    for (const id of plugins) if (typeof id === 'string') {
      let label = id;
      try { const address = new URL(id.startsWith('-') ? id.slice(1) : id); if (['http:', 'https:'].includes(address.protocol)) label = (id.startsWith('-') ? '-' : '') + address.origin + address.pathname; } catch { /* Package/file reference, not a web URL. */ }
      rows.push({ kind: 'plugin', id: `declared-${hash(id).slice(0, 16)}`, name: label, source: state.layers.find(layer => layer.value.plugin?.includes(id) || layer.value.plugins?.some(value => value === id || value?.package === id))?.file || '', installed: null,
      globalEnabled: true, globalOverride: null, projectOverride: null, globalEditable: false, projectEditable: false, projectDefined: false,
      note: state.family === 2 ? 'V2 plugin declarations/directives are listed, not proof of installation. Enable/disable requires the actual native plugin ID, which is not inferred from a package name.' : 'Native plugin declarations are listed, not proof of installation. OpenCode 1.x has no per-plugin enabled switch; inherited arrays cannot be disabled with an MCP override.' });
    }
    return { agent: 'opencode', trust: 'Native OpenCode permissions', rows, duplicates: [], notice: state.locked ? 'Custom/runtime OpenCode configuration detected. Controls are read-only; edit its source.' : state.family === 2 ? 'V2 local MCP definitions replace global entries. Inherit removes an unchanged Mik-generated override; externally edited definitions are retained. Literal credential fields require explicit configuration. File inventory is not live connection status.' : 'File inventory only. Agent permissions, ancestor/remote/managed configuration may affect native availability. Changes apply to new chats.' };
  }
  async managed(projectId, repositoryId, scope = 'project') {
    if (!['global', 'project'].includes(scope)) throw bad('Choose a valid OpenCode scope.');
    const state = await this.state(scope === 'global' ? null : projectId, repositoryId), file = scope === 'global' ? state.globalFile : state.projectFile;
    if (!file) throw bad('Choose a linked project.');
    const registry = await this.registry();
    const doc = await openCodeDocument(file);
    return { file, scope, servers: Object.entries(object((scope === 'global' ? state.global : state.local).mcp)).map(([name, value]) => ({ name, transport: value.type === 'remote' ? 'http' : 'stdio', enabled: value.enabled !== false, managed: registry[file]?.[name] === hash(doc.value.mcp?.servers?.[name] || doc.value.mcp?.[name]) })), note: 'OpenCode native configuration; credentials are never returned. On/Off can also manage external definitions. Replacing/removing requires a Mr. Mik-owned definition.' };
  }
  async registry() {
    const file = path.join(this.stateDir, 'opencode-managed.json');
    try { const value = JSON.parse(await readFile(file, 'utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw bad('OpenCode ownership registry is invalid.'); }
  }
  change({ projectId, repositoryId, scope = 'project', action = 'toggle', kind = 'mcp', id, name = id, enabled, transport, url, command, args = [] }) {
    const job = this.pending.catch(() => {}).then(async () => {
      if (!['global', 'project'].includes(scope) || !['mcp', 'skill', 'plugin'].includes(kind) || !(kind === 'plugin' ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(name || '') && !name.startsWith('mr-mik') : kind === 'skill' ? configurableSkillId(name) : nameOK(name))) throw bad('Choose a configurable OpenCode component and scope.');
      const state = await this.state(projectId, repositoryId);
      if (state.locked) throw bad('Custom/runtime OpenCode configuration takes precedence. Edit its source instead.');
      if (scope === 'project' && !state.root) throw bad('Choose a linked project.');
      const file = scope === 'global' ? state.globalFile : state.projectFile, doc = await openCodeDocument(file);
      const registry = await this.registry(), owned = { ...object(registry[file]) };
      let source = doc.source || '{}\n';
      const edit = (keys, value) => { source = applyEdits(source, modify(source, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })); };
      if (kind === 'plugin') {
        const row = state.family === 2 && (await this.pluginRows(state)).find(item => item.id === name);
        if (!row || !(scope === 'global' ? row.globalEditable : row.projectEditable) || ![true, false, null].includes(enabled)) throw bad('Verify this native V2 plugin in an open chat at the selected folder first.');
        const values = (doc.value.plugins || []).filter(value => value !== `-${name}`);
        if (enabled === true) {
          const remaining = state.layers.flatMap(layer => layer.file === file ? values : layer.value.plugins || []);
          if (remaining.some(value => typeof value === 'string' && value.startsWith('-') && new RegExp(`^${value.slice(1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name))) throw bad('An inherited or wildcard exclusion still blocks this plugin. Edit that source; no package/options were copied.');
        }
        if (enabled === false) values.push(`-${name}`);
        edit(['plugins'], values.length ? values : undefined);
      } else if (kind === 'skill') {
        if (!(await this.skills(state)).some(skill => skill.id === name) || ![true, false, null].includes(enabled)) throw bad('Choose a discovered skill and On, Off or Inherit.');
        if (state.family === 2) {
          const rules = (doc.value.permissions || []).filter(rule => !(rule.action === 'skill' && rule.resource === name));
          if (enabled !== null) rules.push({ action: 'skill', resource: name, effect: enabled ? 'allow' : 'deny' });
          edit(['permissions'], rules);
          if (object(doc.value.permission?.skill)[name] !== undefined) edit(['permission', 'skill', name], undefined);
        } else {
          if (typeof doc.value.permission === 'string') edit(['permission'], { '*': doc.value.permission });
          if (typeof doc.value.permission?.skill === 'string') edit(['permission', 'skill'], { '*': doc.value.permission.skill });
          edit(['permission', 'skill', name], enabled === null ? undefined : enabled ? 'allow' : 'deny');
        }
      } else {
        if (!['save', 'toggle', 'remove'].includes(action)) throw bad('Choose an MCP action.');
        const legacy = doc.value.mcp?.[name], native = doc.value.mcp?.servers?.[name];
        const v2 = !!native || state.family === 2 && (!legacy || Object.keys(legacy).every(key => key === 'enabled'));
        const keys = v2 ? ['mcp', 'servers', name] : ['mcp', name], flag = v2 ? 'disabled' : 'enabled';
        const existing = v2 ? native : legacy, effective = state.merged.mcp?.[name];
        if (v2 && legacy && Object.keys(legacy).every(key => key === 'enabled')) edit(['mcp', name], undefined);
        if (action === 'save' || action === 'remove') {
          if (existing && owned[name] !== hash(existing)) throw bad('This definition was created or changed outside Mr. Mik. Use its source to replace or remove it; On/Off is still available.');
          if (action === 'remove') { if (!existing) throw bad('No owned definition here.'); edit(keys, undefined); delete owned[name]; delete owned[`override:${name}`]; }
          else {
            let definition;
            if (transport === 'http') {
              let address; try { address = new URL(url); } catch { throw bad('Enter a valid MCP URL.'); }
              if (!(address.protocol === 'https:' || address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) || address.username || address.password || address.search || address.hash) throw bad('Use HTTPS or localhost HTTP without embedded credentials.');
              definition = { type: 'remote', url, enabled: enabled !== false };
            } else {
              if (transport !== 'stdio' || typeof command !== 'string' || !command.trim() || command.length > 1024 || /[\r\n]/.test(command) || !Array.isArray(args) || args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 1024)) throw bad('Enter a command and up to 40 arguments.');
              definition = { type: 'local', command: [command.trim(), ...args], enabled: enabled !== false };
            }
            if (v2) { definition.disabled = !definition.enabled; delete definition.enabled; }
            edit(keys, definition); owned[name] = hash(definition);
          }
        } else {
          if (!effective || ![true, false, null].includes(enabled) || scope === 'global' && !state.global.mcp?.[name]) throw bad('Choose a defined MCP and On, Off or Inherit.');
          if (enabled === null && existing && (Object.keys(existing).every(key => key === flag) || owned[`override:${name}`] === hash(existing))) { edit(keys, undefined); delete owned[`override:${name}`]; }
          else if (v2 && !existing && enabled !== null) {
            // Native V2 requires transport fields even for an inherited toggle.
            // V2 replaces server entries across layers. Preserve options, but
            // refuse automatic propagation of literal credential fields.
            const override = { ...safeInheritedV2Server(effective), disabled: !enabled };
            edit(keys, override); owned[`override:${name}`] = hash(override);
          } else {
            edit([...keys, flag], enabled === null ? undefined : v2 ? !enabled : enabled);
            if (v2 && existing && owned[`override:${name}`] === hash(existing)) owned[`override:${name}`] = hash(parse(source).mcp?.servers?.[name]);
          }
          if (!existing && !legacy && enabled === null) source = doc.source || '{}\n';
          if (existing && owned[name] === hash(existing)) { const next = v2 ? parse(source).mcp?.servers?.[name] : parse(source).mcp?.[name]; owned[name] = hash(next); }
        }
      }
      const base = scope === 'global' ? path.dirname(file) : state.root;
      // Reject directory junctions below the selected root, including .opencode.
      let parent = base;
      if (scope === 'global') { const info = await lstat(base).catch(() => null); if (info?.isSymbolicLink()) throw bad('Configuration folder is a link.'); await mkdir(base, { recursive: true }); }
      for (const segment of path.relative(base, path.dirname(file)).split(path.sep).filter(Boolean)) { parent = path.join(parent, segment); const info = await lstat(parent).catch(() => null); if (info && (!info.isDirectory() || info.isSymbolicLink())) throw bad('Configuration folder is not a regular directory.'); if (!info) await mkdir(parent); }
      const current = await openCodeDocument(file); if (current.source !== doc.source) throw bad('OpenCode configuration changed. Refresh and retry.');
      if (doc.source !== null) { await mkdir(path.join(this.stateDir, 'opencode-config-backups'), { recursive: true }); await writeFile(path.join(this.stateDir, 'opencode-config-backups', `${randomUUID()}.jsonc`), doc.source, { flag: 'wx', mode: 0o600 }); }
      const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, source, { flag: 'wx', mode: 0o600 }); await rename(temp, file);
      await saveJson(path.join(this.stateDir, 'opencode-managed.json'), { ...registry, [file]: owned });
      return { saved: true, file, scope, name, applies: 'New OpenCode chats only.' };
    }); this.pending = job; return job;
  }
}
