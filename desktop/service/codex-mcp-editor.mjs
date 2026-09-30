import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { parse as toml } from 'smol-toml';
import { sleep, within } from './util.mjs';

const BEGIN = '# BEGIN MR MAK MCP DEFINITIONS';
const END = '# END MR MAK MCP DEFINITIONS';
const bad = message => Object.assign(new Error(message), { status: 400 });
const read = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const parse = text => { try { return toml(text.replace(/^\uFEFF/, '')); } catch { throw bad('Codex config is malformed; no changes were made.'); } };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function split(text) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end <= start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0))) throw bad('Mr. Mik MCP markers are damaged; no changes were made.');
  if (start < 0) return { outside: text, owned: '' };
  return { outside: text.slice(0, start) + text.slice(end + END.length), owned: text.slice(start + BEGIN.length, end) };
}

function validate(input) {
  const { name, transport, url, command, args = [], enabled = true } = input;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(name) || ['mrmak_workspace', 'node_repl', 'cua_repl'].includes(name)) throw bad('Choose a valid MCP server name.');
  if (!['http', 'stdio'].includes(transport) || typeof enabled !== 'boolean') throw bad('Choose HTTP or local process and enabled state.');
  if (transport === 'http') {
    if (typeof url !== 'string' || url.length > 2048) throw bad('Enter a valid MCP URL.');
    let address; try { address = new URL(url); } catch { throw bad('Enter a valid MCP URL.'); }
    if (!(address.protocol === 'https:' || address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) || address.username || address.password || address.search || address.hash) throw bad('Use HTTPS or local HTTP without credentials or query parameters.');
    return { name, url, enabled };
  }
  if (typeof command !== 'string' || !command.trim() || command.length > 1024 || /[\r\n]/.test(command) || !Array.isArray(args) || args.length > 40 || args.some(arg => typeof arg !== 'string' || arg.length > 1024)) throw bad('Enter a command and up to 40 arguments.');
  return { name, command: command.trim(), args, enabled };
}

export class CodexMcpEditor {
  constructor(projects, { home = os.homedir(), env = process.env } = {}) { this.projects = projects; this.home = home; this.env = env; this.pending = Promise.resolve(); }
  async target(scope, projectId, repositoryId) {
    if (scope === 'global') {
      const folder = this.env.CODEX_HOME || path.join(this.home, '.codex');
      return { folder, file: path.join(folder, 'config.toml'), root: folder };
    }
    if (scope !== 'project') throw bad('Choose Global or Project.');
    const root = await this.projects.root(projectId, repositoryId);
    return { folder: path.join(root, '.codex'), file: path.join(root, '.codex', 'config.toml'), root };
  }
  async state(scope, projectId, repositoryId) {
    const target = await this.target(scope, projectId, repositoryId);
    const original = await read(target.file);
    if (original.length > 1024 * 1024) throw bad('Codex config is too large to edit safely.');
    const { outside, owned } = split(original);
    const foreign = parse(outside), managed = parse(owned);
    parse(original);
    return { ...target, original, outside, foreign, managed };
  }
  async list(scope, projectId, repositoryId) {
    const state = await this.state(scope, projectId, repositoryId);
    return { scope, file: state.file, servers: Object.entries(object(state.managed.mcp_servers)).map(([name, config]) => ({ name, transport: config.url ? 'http' : 'stdio', enabled: config.enabled !== false })),
      note: 'Only MCP definitions created by Mr. Mik can be edited here. Other entries and plugin servers keep their source configuration.' };
  }
  async change({ scope, projectId, repositoryId, action, name, transport, url, command, args, enabled }) {
    if (!['save', 'remove', 'toggle'].includes(action)) throw bad('Choose an MCP action.');
    const job = this.pending.catch(() => {}).then(async () => {
      const state = await this.state(scope, projectId, repositoryId);
      const servers = { ...object(state.managed.mcp_servers) };
      if (action === 'save') {
        const next = validate({ name, transport, url, command, args, enabled });
        if (state.foreign.mcp_servers?.[name]) throw bad('This server is maintained outside Mr. Mik; edit its source config.');
        const { name: ignored, ...configuration } = next;
        void ignored;
        servers[name] = configuration;
      } else {
        if (typeof name !== 'string' || !Object.hasOwn(servers, name)) throw bad('This server is not managed by Mr. Mik.');
        if (action === 'remove') delete servers[name];
        else if (typeof enabled === 'boolean') servers[name] = { ...servers[name], enabled };
        else throw bad('Choose enabled or disabled.');
      }
      const lines = [];
      for (const [id, config] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`[mcp_servers.${JSON.stringify(id)}]`);
        if (config.url) lines.push(`url = ${JSON.stringify(config.url)}`);
        else { lines.push(`command = ${JSON.stringify(config.command)}`); lines.push(`args = ${JSON.stringify(config.args || [])}`); }
        lines.push(`enabled = ${config.enabled !== false}`, '');
      }
      const next = state.outside.trimEnd() + (state.outside.trim() && lines.length ? '\n\n' : state.outside.trim() ? '\n' : '') + (lines.length ? BEGIN + '\n' + lines.join('\n') + END + '\n' : '');
      parse(next);
      if (hash(await read(state.file)) !== hash(state.original)) throw bad('Codex config changed during editing. Refresh before retrying.');
      await mkdir(state.folder, { recursive: true });
      if (!within(await realpath(state.root), await realpath(state.folder))) throw bad('Codex config folder leaves its expected location.');
      const info = await lstat(state.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isSymbolicLink() || info && !info.isFile()) throw bad('Codex config is not a regular file.');
      const temp = `${state.file}.${randomBytes(5).toString('hex')}.tmp`;
      await writeFile(temp, next, { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, state.file); break; }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error; await sleep(25 * (attempt + 1)); }
      }
      return { saved: true, scope, name, file: state.file, applies: 'New Codex sessions only.' };
    });
    this.pending = job; return job;
  }
}
