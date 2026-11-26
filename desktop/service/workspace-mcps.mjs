import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpInventory } from './mcp.mjs';
import { mcpSnapshot } from './tool-refresh.mjs';
import { CodexScopes } from './codex-scopes.mjs';
import { claudeJson } from './claude-settings.mjs';

const key = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// Main-only composition. Never install definitions or widen another workspace.
export async function resolveWorkspaceMcps(projects, session, options = {}, { ownScan } = {}) {
  const result = { definitions: {}, snapshot: {}, origins: [], issues: [], claudePermissions: { deny: [], ask: [] } };
  if (!session.projectId || !['claude', 'codex'].includes(session.agent)) return result;
  const scanOptions = session.agent === 'codex' && session.chatInterface === 'chat' ? { client: 'codex' } : {};
  // Share an observation only inside the caller's current snapshot operation.
  // Launch construction and subsequent refreshes must make a fresh observation.
  if (ownScan && (!(ownScan.raw instanceof Map) || !ownScan.public?.repo || key(ownScan.public.repo) !== key(session.cwd))) throw new Error('MCP observation belongs to another working folder.');
  let own = ownScan;
  if (!own) {
    const inventory = new McpInventory(session.cwd, options);
    try { own = await inventory.scan(scanOptions); } finally { inventory.close(); }
  }
  const project = await projects.get(session.projectId);
  const main = project.repositories[0];
  if (session.repositoryId && session.repositoryId !== main?.id) return result;
  if (session.repositoryId && key(await projects.root(project.id, main.id)) !== key(session.cwd)) throw new Error('Main project location changed. Reopen this conversation.');
  const ownRows = [...own.raw.values()].filter(entry => entry.data.client === session.agent);
  const blocked = new Set(ownRows.filter(entry => !entry.data.enabled && entry.data.sources.some(source => ['local', 'project', 'managed'].includes(source.scope))).map(entry => entry.data.name));
  if (session.agent === 'claude') {
    const home = options.home || os.homedir(), configDir = options.env?.CLAUDE_CONFIG_DIR;
    const user = (await claudeJson(configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json'))).value;
    const local = Object.entries(user.projects || {}).find(([folder]) => key(folder) === key(session.cwd))?.[1] || {};
    for (const name of [...(local.disabledMcpServers || []), ...(local.disabledMcpjsonServers || [])]) blocked.add(name);
    for (const file of ['settings.json', 'settings.local.json']) {
      const settings = (await claudeJson(path.join(session.cwd, '.claude', file))).value;
      for (const name of settings.disabledMcpjsonServers || []) blocked.add(name);
    }
  }
  const equivalent = entry => hash([entry.config, entry.headers, ...(entry.data.transport === 'stdio' ? [entry.cwd, entry.env] : [])]);
  const seen = new Set(ownRows.filter(entry => entry.data.enabled).map(equivalent));
  const names = new Map(ownRows.filter(entry => entry.data.enabled).map(entry => [entry.data.name, equivalent(entry)]));
  const conflicts = new Set();
  for (const repository of project.repositories) {
    if (repository.id === session.repositoryId || !repository.available) continue;
    const root = await projects.root(project.id, repository.id);
    if (key(root) === key(session.cwd)) continue;
    const inventory = new McpInventory(root, options);
    let scan; try { scan = await inventory.scan(scanOptions); } finally { inventory.close(); }
    if (scan.public.problems.length) throw new Error('A linked project MCP configuration is unreadable. Check Tools for that folder.');
    const trust = session.agent === 'codex' ? (await new CodexScopes({ root: async () => root }, options).list('linked')).trust : null;
    const restrictions = { deny: [], ask: [] };
    if (session.agent === 'claude') for (const file of ['settings.json', 'settings.local.json']) {
      const settings = (await claudeJson(path.join(root, '.claude', file))).value;
      for (const kind of ['deny', 'ask']) restrictions[kind].push(...(Array.isArray(settings.permissions?.[kind]) ? settings.permissions[kind].filter(rule => typeof rule === 'string' && rule.length < 1000) : []));
    }
    for (const entry of scan.raw.values()) {
      const data = entry.data;
      if (data.client !== session.agent || data.name === 'mrmak_workspace' || data.plugin || data.scope === 'managed' || !data.sources.some(source => ['local', 'project'].includes(source.scope))) continue;
      if (!data.enabled || blocked.has(data.name)) continue;
      const fingerprint = equivalent(entry);
      if (seen.has(fingerprint)) continue;
      const alias = data.name;
      result.snapshot[`linked:${repository.id}:${data.name}`] = { name: alias, enabled: true, plugin: false, definition: hash([mcpSnapshot(scan, session.agent)[data.id], root, trust, restrictions]) };
      // Keep native server names so allow/deny patterns and per-tool policies
      // retain their meaning. Different same-name definitions are unavailable
      // until explicitly resolved in Tools; never choose or rename silently.
      if (names.has(alias) || conflicts.has(alias) || !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(alias)) {
        delete result.definitions[alias]; conflicts.add(alias);
        result.origins = result.origins.filter(row => row.name !== alias);
        result.issues.push({ repository: repository.name, name: data.name, reason: 'Conflicting MCP name. Resolve the definitions in Tools before sharing.' }); continue;
      }
      if (session.agent === 'codex' && trust !== 'trusted' || !['configured'].includes(data.readiness) || entry.config.http_headers_helper || entry.config.headersHelper || entry.config.oauth || data.transport === 'ws') {
        result.issues.push({ repository: repository.name, name: data.name, reason: 'Needs native setup or approval in the linked project.' }); continue;
      }
      if (Object.keys(result.definitions).length >= 64) throw new Error('Workspace MCP visibility exceeds 64 linked servers.');
      seen.add(fingerprint);
      names.set(alias, fingerprint);
      result.definitions[alias] = { transport: data.transport, command: entry.command, args: entry.config.args || [], cwd: entry.cwd, env: entry.env, url: entry.config.url, headers: entry.headers, timeout: entry.config.startup_timeout_sec,
        ...(session.agent === 'codex' ? { nativePolicy: Object.fromEntries(['enabled_tools', 'disabled_tools', 'tool_timeout_sec', 'startup_timeout_sec', 'required'].filter(key => entry.config[key] !== undefined).map(key => [key, entry.config[key]])) } : {}) };
      result.origins.push({ name: alias, server: data.name, repositoryId: repository.id, repository: repository.name });
      if (session.agent === 'claude') for (const kind of ['deny', 'ask']) for (const rule of restrictions[kind]) {
        if (rule === '*' || rule === 'mcp__*') result.claudePermissions[kind].push(`mcp__${alias}__*`);
        else if (rule === `mcp__${alias}` || rule.startsWith(`mcp__${alias}__`)) result.claudePermissions[kind].push(rule);
      }
    }
  }
  for (const kind of ['deny', 'ask']) result.claudePermissions[kind] = [...new Set(result.claudePermissions[kind])].filter(rule => Object.keys(result.definitions).some(name => rule === `mcp__${name}` || rule.startsWith(`mcp__${name}__`)));
  return result;
}

export class WorkspaceMcpLaunches {
  constructor(stateDir) { this.folder = path.join(stateDir, 'linked-mcp-launches'); this.files = new Map(); }
  async claudePlatform(session, servers) {
    const encoded = JSON.stringify({ mcpServers: servers });
    if (Buffer.byteLength(encoded) > 2 * 1024 ** 2) throw new Error('Claude MCP configuration exceeds its supported size.');
    await mkdir(this.folder, { recursive: true });
    const info = await lstat(this.folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace MCP runtime folder must be a regular directory.');
    const file = path.join(this.folder, `${randomUUID()}.json`);
    await writeFile(file, encoded, { mode: 0o600, flag: 'wx' });
    const files = this.files.get(session.id) || new Set(); files.add(file); this.files.set(session.id, files);
    return file;
  }
  async prepare(session, resolved, preview = false) {
    const encoded = JSON.stringify({ servers: resolved.definitions });
    if (Buffer.byteLength(encoded) > 2 * 1024 ** 2) throw new Error('Linked MCP runtime configuration exceeds its supported size.');
    if (!Object.keys(resolved.definitions).length || preview) return {};
    await mkdir(this.folder, { recursive: true });
    const info = await lstat(this.folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Workspace MCP runtime folder must be a regular directory.');
    const file = path.join(this.folder, `${randomUUID()}.json`);
    await writeFile(file, encoded, { mode: 0o600, flag: 'wx' });
    const files = this.files.get(session.id) || new Set(); files.add(file); this.files.set(session.id, files);
    const script = fileURLToPath(new URL('./workspace-mcp-host.mjs', import.meta.url));
    return Object.fromEntries(Object.entries(resolved.definitions).map(([name, entry]) => [name, { command: process.execPath, args: [script, file, name], enabled: true, ...entry.nativePolicy }]));
  }
  async release(id) {
    const files = this.files.get(id); this.files.delete(id);
    if (files) for (const file of files) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async close() { for (const id of [...this.files.keys()]) await this.release(id); }
}
