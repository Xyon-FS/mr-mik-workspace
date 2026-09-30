import path from 'node:path';
import os from 'node:os';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { saveJson } from './util.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const bad = message => Object.assign(new Error(message), { status: 400 });
export async function claudeJson(file) {
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { source: null, value: {} };
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw bad('Claude settings must be a regular JSON file of supported size.');
  const source = await readFile(file, 'utf8');
  let value; try { value = JSON.parse(source); } catch { throw bad('Claude settings contain invalid JSON. Repair them before editing.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Claude settings must contain an object.');
  return { source, value };
}

export class ClaudeSettings {
  constructor(projects, { home = os.homedir(), env = process.env } = {}) {
    Object.assign(this, { projects, home, env, pending: Promise.resolve() });
  }
  get directory() { return this.env.CLAUDE_CONFIG_DIR || path.join(this.home, '.claude'); }
  async files(projectId, repositoryId) {
    const root = projectId ? await this.projects.root(projectId, repositoryId) : null;
    return { root, global: path.join(this.directory, 'settings.json'), shared: root && path.join(root, '.claude', 'settings.json'), local: root && path.join(root, '.claude', 'settings.local.json') };
  }
  async list(projectId, repositoryId) {
    const files = await this.files(projectId, repositoryId);
    const global = (await claudeJson(files.global)).value;
    const shared = files.shared ? (await claudeJson(files.shared)).value : {};
    const local = files.local ? (await claudeJson(files.local)).value : {};
    const rows = [];
    const installed = (await claudeJson(path.join(this.directory, 'plugins', 'installed_plugins.json'))).value;
    const plugins = new Set([...Object.keys(object(installed.plugins)), ...Object.keys(object(global.enabledPlugins)), ...Object.keys(object(shared.enabledPlugins)), ...Object.keys(object(local.enabledPlugins))]);
    for (const id of plugins) {
      const locations = Array.isArray(installed.plugins?.[id]) ? installed.plugins[id] : [];
      const installation = locations.find(item => !item.projectPath || files.root && path.resolve(item.projectPath).toLowerCase() === files.root.toLowerCase());
      const globalOverride = typeof global.enabledPlugins?.[id] === 'boolean' ? global.enabledPlugins[id] : null;
      const projectOverride = typeof local.enabledPlugins?.[id] === 'boolean' ? local.enabledPlugins[id] : null;
      rows.push({ kind: 'plugin', id, name: id.split('@')[0], source: installation?.installPath || 'Claude settings', version: installation?.version || null, installed: !!installation, globalOverride, globalEnabled: globalOverride === true, projectOverride, projectDefined: typeof shared.enabledPlugins?.[id] === 'boolean', effective: projectOverride ?? shared.enabledPlugins?.[id] ?? globalOverride ?? false, globalEditable: true, projectEditable: !!files.root, note: 'Native enabledPlugins settings. Managed policy can override personal settings. Changes apply to new chats.' });
    }
    const skills = new Map();
    for (const [folder, source] of [[path.join(this.directory, 'skills'), 'Claude user skills'], ...(files.root ? [[path.join(files.root, '.claude', 'skills'), 'Linked-project skills']] : [])]) {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name, 'SKILL.md');
        const info = await lstat(file).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
        const text = await readFile(file, 'utf8');
        const name = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1].match(/^name:\s*["']?([^\r\n"']+)/m)?.[1].trim() || entry.name;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) continue;
        skills.set(name, { name, source, path: file });
      }
    }
    for (const skill of skills.values()) {
      const convert = value => value === 'off' ? false : value === 'on' ? true : null;
      const globalState = global.skillOverrides?.[skill.name];
      const projectState = local.skillOverrides?.[skill.name];
      rows.push({ kind: 'skill', id: skill.name, ...skill, globalOverride: convert(globalState), globalEnabled: globalState !== 'off', projectOverride: convert(projectState), projectDefined: shared.skillOverrides?.[skill.name] != null, globalEditable: true, projectEditable: !!files.root, state: projectState ?? shared.skillOverrides?.[skill.name] ?? globalState ?? 'on', note: 'Native skillOverrides; plugin skills are controlled by their plugin, not this switch.' });
    }
    return { rows, notice: 'Native Claude settings. Managed policies and project approvals remain authoritative.', trust: 'Check in Claude' };
  }
  async set(projectId, { repositoryId, kind, id, scope = 'project', enabled }) {
    if (!['skill', 'plugin'].includes(kind) || !['global', 'project'].includes(scope) || typeof id !== 'string' || !id || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id) || enabled !== null && typeof enabled !== 'boolean') throw bad('Choose a Claude component, scope and state.');
    const job = this.pending.catch(() => {}).then(async () => {
      const files = await this.files(projectId, repositoryId);
      if (scope === 'project' && !files.local) throw bad('Choose a linked project first.');
      const inventory = await this.list(projectId, repositoryId);
      if (!inventory.rows.some(row => row.kind === kind && row.id === id)) throw bad('Claude component was not found. Refresh first.');
      const file = scope === 'global' ? files.global : files.local;
      const parent = await lstat(path.dirname(file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw bad('Claude settings directory must be a regular folder, not a link.');
      const { source, value } = await claudeJson(file);
      const key = kind === 'skill' ? 'skillOverrides' : 'enabledPlugins';
      if (value[key] != null && (typeof value[key] !== 'object' || Array.isArray(value[key]))) throw bad('Claude component settings have an invalid format.');
      const entries = { ...object(value[key]) };
      if (enabled === null) delete entries[id]; else entries[id] = kind === 'skill' ? enabled ? 'on' : 'off' : enabled;
      if ((await claudeJson(file)).source !== source) throw bad('Claude settings changed. Refresh and retry.');
      await saveJson(file, { ...value, [key]: entries });
      return { saved: true, file, applies: 'New Claude chats. Managed policy may override this setting.' };
    });
    this.pending = job; return job;
  }
}
