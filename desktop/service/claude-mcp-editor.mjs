import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { saveJson } from './util.mjs';
import { claudeJson } from './claude-settings.mjs';

const bad = message => Object.assign(new Error(message), { status: 400 });
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();

function definition({ name, transport, url, command, args = [] }) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(name)) throw bad('Choose a valid MCP server name.');
  if (transport === 'http') {
    if (typeof url !== 'string' || url.length > 2048) throw bad('Enter a valid MCP URL.');
    let address; try { address = new URL(url); } catch { throw bad('Enter a valid MCP URL.'); }
    if (!(address.protocol === 'https:' || address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) || address.username || address.password || address.search || address.hash) throw bad('Use HTTPS or local HTTP without embedded credentials.');
    return { type: 'http', url };
  }
  if (transport !== 'stdio' || typeof command !== 'string' || !command.trim() || command.length > 1024 || /[\r\n]/.test(command) || !Array.isArray(args) || args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 1024)) throw bad('Enter a command and up to 40 arguments.');
  return { type: 'stdio', command: command.trim(), args };
}

export class ClaudeMcpEditor {
  constructor(projects, stateDir, { home = os.homedir(), env = process.env } = {}) {
    Object.assign(this, { projects, stateDir, home, env, pending: Promise.resolve() });
    this.registryFile = path.join(stateDir, 'claude-mcp-managed.json');
  }
  get configFile() { return this.env.CLAUDE_CONFIG_DIR ? path.join(this.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(this.home, '.claude.json'); }
  get disabledFile() { return path.join(this.env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude'), 'mrmak-disabled-mcp.json'); }
  async state(projectId, repositoryId, scope = 'local') {
    if (!['local', 'global'].includes(scope)) throw bad('Choose Global or Linked project.');
    const root = scope === 'global' ? null : await this.projects.root(projectId, repositoryId);
    const registryKey = scope === 'global' ? 'global' : repositoryId && repositoryId !== 'primary' ? `${projectId}:${repositoryId}` : projectId;
    const file = this.configFile;
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)) throw bad('Claude configuration is not a regular file of supported size.');
    const source = info ? await readFile(file, 'utf8') : null;
    let document;
    try { document = source == null ? {} : JSON.parse(source); } catch { throw bad('Claude configuration has invalid JSON. Repair it before editing.'); }
    if (document !== Object(document) || Array.isArray(document)) throw bad('Claude configuration has an invalid root object.');
    if (document.projects != null && (document.projects !== Object(document.projects) || Array.isArray(document.projects))) throw bad('Claude project settings have an invalid format.');
    if (root && Object.keys(object(document.projects)).filter(folder => canonical(folder) === canonical(root)).length > 1) throw bad('Claude has duplicate entries for this project path. Resolve them before editing.');
    const projectKey = root ? Object.keys(object(document.projects)).find(folder => canonical(folder) === canonical(root)) || root : null;
    if (document.projects?.[projectKey] != null && (document.projects[projectKey] !== Object(document.projects[projectKey]) || Array.isArray(document.projects[projectKey]))) throw bad('Claude project settings have an invalid format.');
    const project = root ? object(document.projects?.[projectKey]) : null;
    const inactive = await claudeJson(this.disabledFile);
    const parked = { ...object(document.mrmakDisabledMcpServers), ...object(inactive.value.mcpServers) };
    for (const value of [document.mcpServers, document.mrmakDisabledMcpServers, project?.mcpServers]) {
      if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw bad('Claude MCP definitions have an invalid format.');
    }
    if (project?.disabledMcpServers != null && (!Array.isArray(project.disabledMcpServers) || project.disabledMcpServers.some(name => typeof name !== 'string'))) throw bad('Claude MCP exclusions have an invalid format.');
    let registry;
    try { registry = JSON.parse(await readFile(this.registryFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') registry = {}; else throw bad('Mr. Mik MCP ownership registry cannot be read. Repair it before editing.'); }
    if (registry !== Object(registry) || Array.isArray(registry)) throw bad('Mr. Mik MCP ownership registry is invalid.');
    const record = object(registry[registryKey]);
    const owned = record.root === (root ? canonical(root) : 'global') ? object(record.servers) : {};
    return { root, file, source, document, projectKey, project, registry, registryKey, owned, scope, parked, parkedSource: inactive.source };
  }
  async list(projectId, repositoryId, scope = 'local') {
    const state = await this.state(projectId, repositoryId, scope);
    const parked = state.parked;
    const servers = scope === 'global' ? { ...parked, ...object(state.document.mcpServers) } : object(state.project.mcpServers);
    return { scope, file: state.file, servers: Object.entries(servers).map(([name, server]) => ({ name, transport: server.url ? 'http' : 'stdio', managed: state.owned[name] === hash(server), enabled: scope === 'global' ? !!state.document.mcpServers?.[name] : !state.project.disabledMcpServers?.includes(name) })), disabledMcpServers: scope === 'local' ? (Array.isArray(state.project.disabledMcpServers) ? state.project.disabledMcpServers : []).filter(name => typeof name === 'string') : [], disabledGlobal: Object.keys(parked), note: scope === 'global' ? 'Global Off preserves the definition in a private inactive section of Claude configuration; On restores it. No credentials are returned or exported.' : 'Local to this linked project on this computer. Native approvals and managed policy still apply.' };
  }
  async change({ projectId, repositoryId, scope = 'local', action, name, transport, url, command, args, enabled }) {
    if (!['save', 'toggle', 'remove', 'override'].includes(action)) throw bad('Choose an MCP action.');
    if (scope === 'global' && action === 'override') throw bad('Choose a linked project for an override.');
    const job = this.pending.catch(() => {}).then(async () => {
      const state = await this.state(projectId, repositoryId, scope);
      const servers = { ...object(scope === 'global' ? state.document.mcpServers : state.project.mcpServers) };
      const parked = { ...state.parked };
      const owned = { ...state.owned };
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw bad('Choose a valid MCP server name.');
      const existing = servers[name] || (scope === 'global' ? parked[name] : null);
      const projectServers = scope === 'local' ? object((await claudeJson(path.join(state.root, '.mcp.json'))).value.mcpServers) : {};
      const record = object(state.registry[state.registryKey]);
      const overrideServers = { ...object(record.overrideServers) };
      if (action === 'override') {
        if (!existing && !state.document.mcpServers?.[name] && !parked[name] && !projectServers[name]) throw bad('This Claude server is not defined for the selected project.');
        if (![true, false, null].includes(enabled)) throw bad('Choose On, Off or Inherit.');
      }
      if (!['override', 'toggle'].includes(action) && existing && owned[name] !== hash(existing)) throw bad('This Claude server is not managed by Mr. Mik or changed outside it. Edit the source configuration.');
      if (!['save', 'override'].includes(action) && !existing) throw bad('This server is not managed by Mr. Mik.');
      const disabled = new Set(Array.isArray(state.project?.disabledMcpServers) ? state.project.disabledMcpServers : []);
      if (action === 'save') {
        servers[name] = definition({ name, transport, url, command, args });
        owned[name] = hash(servers[name]);
        if (scope === 'local') { if (enabled === false) disabled.add(name); else disabled.delete(name); }
        else if (enabled === false) { parked[name] = servers[name]; delete servers[name]; }
      } else if (action === 'toggle') {
        if (typeof enabled !== 'boolean') throw bad('Choose enabled or disabled.');
        if (scope === 'global') {
          if (enabled) { if (servers[name] && parked[name]) throw bad('An active definition with this name already exists. Resolve the conflict before restoring.'); servers[name] = existing; delete parked[name]; }
          else { if (parked[name] && servers[name]) throw bad('An inactive definition with this name already exists. Resolve the conflict first.'); parked[name] = existing; delete servers[name]; }
        } else if (enabled) disabled.delete(name); else disabled.add(name);
      } else if (action === 'override') {
        if (overrideServers[name] && (enabled !== true || !parked[name])) {
          if (!servers[name] || hash(servers[name]) !== overrideServers[name]) throw bad('The local override changed outside Mr. Mik. Resolve it before clearing inheritance.');
          delete servers[name]; delete overrideServers[name]; delete owned[name];
        }
        if (enabled === true && parked[name] && !servers[name] && !projectServers[name]) { servers[name] = parked[name]; overrideServers[name] = hash(servers[name]); owned[name] = hash(servers[name]); }
        if (enabled === false) disabled.add(name); else disabled.delete(name);
      } else { delete servers[name]; delete parked[name]; delete owned[name]; delete overrideServers[name]; disabled.delete(name); }
      if (action === 'save' && (scope !== 'global' || enabled !== false)) delete parked[name];
      const nextProject = scope === 'local' ? { ...state.project, mcpServers: servers, disabledMcpServers: [...disabled] } : null;
      const next = scope === 'global' ? { ...state.document, mcpServers: servers } : { ...state.document, projects: { ...object(state.document.projects), [state.projectKey]: nextProject } };
      delete next.mrmakDisabledMcpServers;
      const current = await readFile(state.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current !== state.source) throw bad('Claude configuration changed during editing. Refresh and retry.');
      const latestInfo = await lstat(state.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (latestInfo?.isSymbolicLink() || latestInfo && !latestInfo.isFile()) throw bad('Claude configuration is not a regular file.');
      if ((await claudeJson(this.disabledFile)).source !== state.parkedSource) throw bad('Inactive Claude definitions changed. Refresh and retry.');
      if (JSON.stringify(parked) !== JSON.stringify(state.parked) || state.document.mrmakDisabledMcpServers) {
        const parent = await lstat(path.dirname(this.disabledFile)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw bad('Inactive Claude definitions must use a regular private folder.');
        // Save the recovery copy before changing active definitions. Claude never
        // reads or rewrites this private file, and portable exports exclude it.
        await saveJson(this.disabledFile, { mcpServers: parked });
      }
      // Never include account/configuration data in the ownership registry or API response.
      // Record ownership first: if the second write fails, the stale hash is ignored.
      await saveJson(this.registryFile, { ...object(state.registry), [state.registryKey]: { root: state.root ? canonical(state.root) : 'global', servers: owned, overrideServers } });
      await saveJson(state.file, next);
      return { saved: true, scope, name, file: state.file, applies: 'New Claude sessions only.' };
    });
    this.pending = job; return job;
  }
}
