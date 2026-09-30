import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { sleep, within } from './util.mjs';
import { setTableEnabled } from './codex-enable-editor.mjs';

const BEGIN = '# BEGIN MR MAK CODEX PROJECT SETTINGS';
const END = '# END MR MAK CODEX PROJECT SETTINGS';
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const rows = value => Array.isArray(value) ? value : [];
const bad = message => Object.assign(new Error(message), { status: 400 });
const hash = value => createHash('sha256').update(value).digest('hex');
const textFile = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const parse = value => { try { return parseToml(value.replace(/^\uFEFF/, '')); } catch { throw bad('Codex config is malformed; no changes were made.'); } };
const skillName = async file => {
  const text = await textFile(file);
  return /^name:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim() || path.basename(path.dirname(file));
};
const hostMarketplaces = new Set(['openai-bundled', 'openai-primary-runtime', 'openai-curated', 'openai-curated-remote']);

export class CodexScopes {
  constructor(projects, { home = os.homedir(), env = process.env } = {}) {
    this.projects = projects; this.home = home; this.env = env; this.pending = Promise.resolve();
  }
  codexHome() { return this.env.CODEX_HOME || path.join(this.home, '.codex'); }
  async target(projectId, repositoryId) {
    const root = await this.projects.root(projectId, repositoryId);
    const folder = path.join(root, '.codex');
    const info = await stat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && !info.isDirectory()) throw bad('Project .codex is not a directory.');
    if (info && !within(root, await realpath(folder))) throw bad('Project .codex leaves its repository.');
    const file = path.join(folder, 'config.toml');
    const fileInfo = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (fileInfo && (!fileInfo.isFile() || !within(root, await realpath(file)))) throw bad('Project Codex config leaves its repository.');
    return { root, folder, file };
  }
  split(text) {
    const start = text.indexOf(BEGIN), end = text.indexOf(END);
    if ((start < 0) !== (end < 0) || (start >= 0 && (end <= start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0))) throw bad('Mr. Mik settings markers are damaged; no changes were made.');
    if (start < 0) return { outside: text, managed: '' };
    const after = end + END.length;
    return { outside: text.slice(0, start) + text.slice(after), managed: text.slice(start + BEGIN.length, end) };
  }
  async skillFiles(folder) {
    const files = [];
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name, 'SKILL.md');
      if ((await stat(file).catch(() => null))?.isFile()) files.push({ id: file, name: await skillName(file), location: file });
    }
    return files;
  }
  async list(projectId, repositoryId) {
    const target = projectId ? await this.target(projectId, repositoryId) : null;
    const root = target?.root || null, file = target?.file || null;
    const userFile = path.join(this.codexHome(), 'config.toml');
    const [userText, projectText] = await Promise.all([textFile(userFile), file ? textFile(file) : '']);
    const user = parse(userText), project = parse(projectText);
    const { outside } = this.split(projectText);
    const foreign = parse(outside);
    const plugins = new Set([...Object.keys(plain(user.plugins)), ...Object.keys(plain(project.plugins))]);
    const pluginRows = await Promise.all([...plugins].sort().map(async id => {
      const at = id.lastIndexOf('@'), source = at > 0 ? id.slice(at + 1) : '';
      const name = at > 0 ? id.slice(0, at) : '';
      const hostManaged = hostMarketplaces.has(source);
      const cache = name && source && !/[\\/]/.test(id) ? path.join(this.codexHome(), 'plugins', 'cache', source, name) : '';
      const versions = cache ? (await readdir(cache, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory()).map(item => item.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
      const bundledSkills = versions.length ? await this.skillFiles(path.join(cache, versions[0], 'skills')) : [];
      return { kind: 'plugin', id, name: id, source: 'Shared installation', location: cache || '', version: versions[0] || null,
        installed: !!versions.length, globalEnabled: user.plugins?.[id]?.enabled === true, globalOverride: user.plugins?.[id]?.enabled ?? null, projectOverride: project.plugins?.[id]?.enabled ?? null,
        bundledSkills: bundledSkills.map(item => item.name), editable: !hostManaged,
        globalEditable: !hostManaged && !!versions.length, projectEditable: !!root && !hostManaged,
        projectDefined: !!foreign.plugins?.[id],
        managedBy: hostManaged ? 'Host/workspace-managed' : 'Local marketplace',
        note: hostManaged ? 'Project override is not supported for this host/workspace-managed marketplace.' : '' };
    }));
    const mcps = new Set([...Object.keys(plain(user.mcp_servers)), ...Object.keys(plain(project.mcp_servers))]);
    const mcpRows = [...mcps].sort().map(id => ({ kind: 'mcp', id, name: id, source: user.mcp_servers?.[id] ? 'User config' : 'Project config', location: user.mcp_servers?.[id] ? userFile : file,
      globalEnabled: user.mcp_servers?.[id] ? user.mcp_servers[id].enabled !== false : false, globalOverride: user.mcp_servers?.[id]?.enabled ?? null, projectOverride: project.mcp_servers?.[id]?.enabled ?? null,
      editable: !['node_repl', 'cua_repl', 'mrmak_workspace'].includes(id),
      globalEditable: !!user.mcp_servers?.[id] && !['node_repl', 'cua_repl', 'mrmak_workspace'].includes(id),
      projectEditable: !!root && !['node_repl', 'cua_repl', 'mrmak_workspace'].includes(id),
      projectDefined: !!foreign.mcp_servers?.[id],
      note: 'The override changes enablement only. A missing server definition is not installed by this control.' }));
    const userSkills = await this.skillFiles(path.join(this.home, '.agents', 'skills'));
    const legacySkills = await this.skillFiles(path.join(this.codexHome(), 'skills'));
    const repoSkills = root ? await this.skillFiles(path.join(root, '.agents', 'skills')) : [];
    const skillRows = [...userSkills, ...legacySkills, ...repoSkills].map(item => ({ kind: 'skill', ...item,
      source: root && within(root, item.location) ? 'Project folder' : 'Personal folder', globalEnabled: !(root && within(root, item.location)), globalOverride: null,
      projectOverride: rows(project.skills?.config).find(row => typeof row.path === 'string' && path.resolve(row.path) === path.resolve(item.id))?.enabled ?? null,
      editable: !rows(foreign.skills?.config).some(row => typeof row.path === 'string' && path.resolve(row.path) === path.resolve(item.id)),
      globalEditable: false, projectEditable: !!root && !rows(foreign.skills?.config).some(row => typeof row.path === 'string' && path.resolve(row.path) === path.resolve(item.id)),
      note: 'Local skill discovery is path-based. Plugin-bundled skills follow their plugin instead.' }));
    const trust = root ? Object.entries(plain(user.projects)).find(([folder]) => path.resolve(folder).toLowerCase() === root.toLowerCase())?.[1]?.trust_level || 'unknown' : 'not applicable';
    const names = new Map();
    for (const row of skillRows) if (row.projectOverride !== false) names.set(row.name.toLowerCase(), [...(names.get(row.name.toLowerCase()) || []), row.source]);
    for (const row of pluginRows) if (row.projectOverride ?? row.globalEnabled) for (const name of row.bundledSkills) names.set(name.toLowerCase(), [...(names.get(name.toLowerCase()) || []), row.id]);
    const duplicates = [...names].filter(([, sources]) => sources.length > 1).map(([name, sources]) => ({ name, sources }));
    return { projectId, repositoryId, root, file, globalFile: userFile, trust, rows: [...pluginRows, ...mcpRows, ...skillRows], duplicates,
      notice: 'Declared settings, not a live-session tool list. Project config loads only when Codex trusts this repository. Existing chats need a new launch to pick up changes.' };
  }
  async set(projectId, { kind, id, enabled, scope = 'project', repositoryId }) {
    if (!['plugin', 'mcp', 'skill'].includes(kind) || typeof id !== 'string' || ![true, false, null].includes(enabled) || !['global', 'project'].includes(scope)) throw bad('Choose a component, scope and enabled state.');
    if (scope === 'global' && enabled === null) throw bad('Global settings require On or Off.');
    const job = this.pending.catch(() => {}).then(async () => {
      const inventory = await this.list(projectId, repositoryId);
      const row = inventory.rows.find(item => item.kind === kind && item.id === id);
      if (!row || !(scope === 'global' ? row.globalEditable : row.projectEditable) || (kind === 'plugin' && enabled === true && !row.installed)) throw bad('This component cannot be changed at the selected scope.');
      if (kind === 'mcp' && !/^[A-Za-z_][A-Za-z_0-9-]*$/.test(id)) throw bad('Unsupported MCP server name.');
      const target = scope === 'project' ? await this.target(projectId, repositoryId) : { root: this.codexHome(), folder: this.codexHome(), file: path.join(this.codexHome(), 'config.toml') };
      const { root, folder, file } = target;
      const original = await textFile(file);
      if (original.length > 1024 * 1024) throw bad('Codex config is too large to edit safely.');
      let next;
      if (scope === 'global') {
        const global = parse(original);
        const present = kind === 'plugin' ? global.plugins?.[id] : global.mcp_servers?.[id];
        if (present) {
          try { next = setTableEnabled(original, kind === 'plugin' ? 'plugins' : 'mcp_servers', id, enabled); }
          catch (error) { throw bad(error.message); }
        } else if (kind === 'plugin') {
          next = original.trimEnd() + (original.trim() ? '\n\n' : '') + `[plugins.${JSON.stringify(id)}]\nenabled = ${enabled}\n`;
        } else throw bad('This MCP server has no global definition to change. Add a global definition first.');
      } else {
        const { outside, managed } = this.split(original);
        const foreign = parse(outside), owned = parse(managed);
        const foreignEntry = kind === 'plugin' ? foreign.plugins?.[id] : kind === 'mcp' ? foreign.mcp_servers?.[id] : rows(foreign.skills?.config).some(item => typeof item.path === 'string' && path.resolve(item.path) === path.resolve(id));
        if (foreignEntry) {
          if (enabled === null) throw bad('This project defines the component itself; choose On or Off. Inherit would not remove its definition.');
          if (kind === 'skill') throw bad('This skill setting is maintained outside Mr. Mik.');
          try { next = setTableEnabled(original, kind === 'plugin' ? 'plugins' : 'mcp_servers', id, enabled); }
          catch (error) { throw bad(error.message); }
        } else {
          if (kind === 'plugin') { owned.plugins ||= {}; if (enabled === null) delete owned.plugins[id]; else { owned.plugins[id] ||= {}; owned.plugins[id].enabled = enabled; } }
          if (kind === 'mcp') { owned.mcp_servers ||= {}; if (enabled === null) delete owned.mcp_servers[id]; else { owned.mcp_servers[id] ||= {}; owned.mcp_servers[id].enabled = enabled; } }
          if (kind === 'skill') {
            owned.skills ||= {}; owned.skills.config = rows(owned.skills.config);
            const entry = owned.skills.config.find(item => typeof item.path === 'string' && path.resolve(item.path) === path.resolve(id));
            if (enabled === null) owned.skills.config = owned.skills.config.filter(item => typeof item.path !== 'string' || path.resolve(item.path) !== path.resolve(id));
            else if (entry) entry.enabled = enabled; else owned.skills.config.push({ path: id, enabled });
          }
          const lines = [];
          for (const [plugin, value] of Object.entries(plain(owned.plugins)).sort(([a], [b]) => a.localeCompare(b))) lines.push(`[plugins.${JSON.stringify(plugin)}]`, `enabled = ${value.enabled}`, '');
          for (const [server, value] of Object.entries(plain(owned.mcp_servers)).sort(([a], [b]) => a.localeCompare(b))) lines.push(`[mcp_servers.${JSON.stringify(server)}]`, `enabled = ${value.enabled}`, '');
          for (const item of rows(owned.skills?.config)) lines.push('[[skills.config]]', `path = ${JSON.stringify(item.path.replaceAll('\\', '/'))}`, `enabled = ${item.enabled}`, '');
          next = lines.length ? outside.trimEnd() + (outside.trim() ? '\n\n' : '') + BEGIN + '\n' + lines.join('\n') + END + '\n' : outside.trimEnd() + '\n';
        }
      }
      parse(next);
      if (hash(await textFile(file)) !== hash(original)) throw bad('Codex config changed during editing. Refresh before retrying.');
      await mkdir(folder, { recursive: true });
      const actualFolder = await realpath(folder), actualRoot = await realpath(root);
      if (path.resolve(actualRoot) !== path.resolve(actualFolder) && !within(actualRoot, actualFolder)) throw bad('Codex config folder leaves its expected location.');
      const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isSymbolicLink() || info && !info.isFile()) throw bad('Codex config is not a regular file.');
      const temp = `${file}.${randomBytes(5).toString('hex')}.tmp`;
      await writeFile(temp, next, { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, file); break; }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error; await sleep(25 * (attempt + 1)); }
      }
      return { saved: true, file, scope, kind, id, enabled, applies: 'New Codex sessions only; project settings also require project trust.' };
    });
    this.pending = job; return job;
  }
}
