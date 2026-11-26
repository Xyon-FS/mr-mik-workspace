import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as toml } from 'smol-toml';
import { commandPath } from './agents.mjs';
import { within } from './util.mjs';
import { jsonRecoveryPlan } from './mcp-recovery-adapters.mjs';

const bad = message => Object.assign(new Error(message), { status: 409 });
const hash = text => createHash('sha256').update(text).digest('hex');
const parse = text => { try { return toml(text.replace(/^\uFEFF/, '')); } catch { throw bad('Codex configuration cannot be parsed safely. Repair its format first.'); } };
const reserved = name => ['node_repl', 'cua_repl', 'mrmak_workspace'].includes(name) || name.startsWith('mr_mik_playwright');

// Conservative surgery on explicit TOML tables. Unsupported syntax is refused,
// never reserialized. Parsed equivalence proves unrelated settings survived.
export function removeCodexServer(text, name) {
  if (/'''|"""/.test(text)) throw bad('Automatic recovery does not support multiline TOML strings. Edit the local definition manually.');
  const before = parse(text);
  if (!before.mcp_servers?.[name]) throw bad('The local MCP definition no longer exists. Refresh Tools.');
  const headers = [...text.matchAll(/^[ \t]*\[{1,2}[^\r\n]+\]{1,2}[^\r\n]*(?:\r?\n|$)/gm)];
  const ranges = [];
  for (let i = 0; i < headers.length; i++) {
    const match = headers[i];
    let probe; try { probe = parse(`${match[0]}\n__mik_recovery_probe = true\n`); } catch { continue; }
    if (!Object.hasOwn(probe.mcp_servers || {}, name)) continue;
    ranges.push([match.index, headers[i + 1]?.index ?? text.length]);
  }
  if (!ranges.length) throw bad('This local definition is not an editable TOML table. Edit it manually.');
  let next = text;
  for (const [start, end] of ranges.reverse()) {
    // Keep standalone comments, including ownership markers and comments for
    // neighbouring tables. Secrets inside removed values are not exposed.
    const comments = text.slice(start, end).split(/(?<=\n)/).filter(line => /^\s*#/.test(line)).join('');
    next = next.slice(0, start) + comments + next.slice(end);
  }
  // `before` is a private parse. Keep null-prototype tables intact for equality.
  const expected = before; delete expected.mcp_servers[name];
  const after = parse(next);
  if (!Object.keys(expected.mcp_servers).length && !after.mcp_servers) delete expected.mcp_servers;
  if (!isDeepStrictEqual(after, expected)) throw bad('The local definition cannot be removed without changing other settings. Edit it manually.');
  return next;
}

async function regular(file, root) {
  if ((await lstat(path.dirname(file))).isSymbolicLink()) throw bad('Recovery does not follow linked configuration folders.');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !within(await realpath(root), await realpath(file)) || info.size > 1024 * 1024) throw bad('Recovery requires a regular configuration file inside its expected location.');
  return readFile(file, 'utf8');
}

function globalUsable(config, env) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.enabled === false || config.disabled === true || reserved(config.name || '')) return false;
  if (/\$\{|\{(?:env|file):/.test(JSON.stringify(config)) || config.bearer_token_env_var && !env[config.bearer_token_env_var] || Object.values(config.env_http_headers || {}).some(name => !env[name])) return false;
  if (Object.hasOwn(config, 'url')) {
    if (['command', 'args', 'env', 'env_vars', 'cwd'].some(field => Object.hasOwn(config, field))) return false;
    try { return ['https:', 'http:'].includes(new URL(config.url).protocol); } catch { return false; }
  }
  if (typeof config.command !== 'string') return false;
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) return false;
  // Relative global commands can resolve differently across projects; refuse
  // them rather than guessing a portable working directory.
  if (/^[.][\\/]/.test(config.command) || config.cwd) return false;
  return !!commandPath(config.command, env);
}

export class McpRecovery {
  constructor(projects, stateDir, { home = os.homedir(), env = process.env } = {}) {
    Object.assign(this, { projects, stateDir, home, env });
    this.plans = new Map(); this.undoPlans = new Map(); this.pending = Promise.resolve();
  }
  readRegular(file, root) { return regular(file, root); }
  usableGlobal(config) { return globalUsable(config, this.env); }
  async preview({ projectId, repositoryId, name, agent = 'codex' }) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9.-]{0,127}$/.test(name) || reserved(name)) throw bad('This MCP name is unsupported or managed by its host and cannot be recovered here.');
    const root = await this.projects.root(projectId, repositoryId);
    if (agent !== 'codex') {
      const adapted = await jsonRecoveryPlan(this, { agent, projectId, repositoryId, name }, root);
      const token = randomBytes(18).toString('hex');
      const review = { token, name, agent, projectId, repositoryId, localFile: adapted.files[0].file, localFiles: adapted.files.map(item => item.file), globalFile: adapted.globalFile, reason: adapted.reason, globalHealth: 'not-checked', transport: adapted.transport, expires: Date.now() + 5 * 60000 };
      if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value);
      this.plans.set(token, { review, root, files: adapted.files, guards: adapted.guards });
      return review;
    }
    const file = path.join(root, '.codex/config.toml');
    const globalRoot = await realpath(this.env.CODEX_HOME || path.join(this.home, '.codex'));
    const globalFile = path.join(globalRoot, 'config.toml');
    if (path.resolve(file).toLowerCase() === globalFile.toLowerCase()) throw bad('A separate local definition is required.');
    const [original, globalText] = await Promise.all([regular(file, root), regular(globalFile, globalRoot)]);
    const local = parse(original).mcp_servers?.[name], global = parse(globalText).mcp_servers?.[name];
    if (!local || local.enabled === false || local.disabled === true || !globalUsable(global, this.env)) throw bad('No usable enabled global configuration matches this local problem.');
    const merged = { ...global, ...local };
    const mixed = Object.hasOwn(merged, 'url') && ['command', 'args', 'env', 'env_vars', 'cwd'].some(field => Object.hasOwn(merged, field));
    const missingLocalCommand = !merged.url && typeof local.command === 'string' && !commandPath(/^[.][\\/]/.test(local.command) ? path.resolve(root, local.command) : local.command, this.env);
    if (!mixed && !missingLocalCommand) throw bad('No attributable local transport or executable problem was found. Network and login errors are not configuration recovery cases.');
    const next = removeCodexServer(original, name);
    const token = randomBytes(18).toString('hex');
    const review = { token, name, agent: 'codex', projectId, repositoryId, localFile: file, globalFile, reason: mixed ? 'Local/global transport fields conflict.' : 'The local executable is missing on this PC.', globalHealth: 'not-checked', transport: global.url ? 'http' : 'stdio', expires: Date.now() + 5 * 60000 };
    if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(token, { review, root, files: [{ file, root, original, next }], guards: [{ file: globalFile, root: globalRoot, original: globalText }] });
    return review;
  }
  async candidates({ projectId, repositoryId }, inventory) {
    const candidates = [];
    if (!projectId) return candidates;
    for (const server of inventory.servers) {
      if (!['codex', 'claude', 'opencode'].includes(server.client) || server.plugin || !server.enabled || !['invalid-config', 'missing-command'].includes(server.readiness)) continue;
      try {
        const review = await this.preview({ projectId, repositoryId, name: server.name, agent: server.client });
        this.plans.delete(review.token);
        candidates.push({ id: server.id, name: server.name, reason: review.reason });
      } catch { /* No safe candidate means no recovery action. */ }
    }
    return candidates;
  }
  async replace(plan, item, expected, next) {
    if ((await this.projects.root(plan.review.projectId, plan.review.repositoryId)).toLowerCase() !== plan.root.toLowerCase()) throw bad('The project was relinked. Review its current configuration again.');
    if (await regular(item.file, item.root) !== expected) throw bad('Local configuration changed. Refresh and review again; no changes were made.');
    const temp = `${item.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, next, { flag: 'wx', mode: 0o600 });
      if (await regular(item.file, item.root) !== expected) throw bad('Local configuration changed during recovery. No changes were made.');
      await rename(temp, item.file);
    } finally { await rm(temp, { force: true }); }
  }
  async apply(token) {
    return this.serialize(async () => {
      const plan = this.plans.get(token);
      if (!plan || Date.now() > plan.review.expires) throw bad('Recovery review expired. Review the configuration again.');
      for (const guard of plan.guards) if (await regular(guard.file, guard.root) !== guard.original) throw bad('Global configuration changed. Review again.');
      for (const item of plan.files) if (await regular(item.file, item.root) !== item.original) throw bad('Local configuration changed. Review again.');
      // Re-evaluate native disabled/managed/custom layers before writing. They
      // can change independently of the files selected for removal.
      if ((await this.projects.root(plan.review.projectId, plan.review.repositoryId)).toLowerCase() !== plan.root.toLowerCase()) throw bad('The project was relinked. Review its current configuration again.');
      const freshReview = await this.preview(plan.review);
      const fresh = this.plans.get(freshReview.token); this.plans.delete(freshReview.token);
      if (!isDeepStrictEqual(fresh.files, plan.files) || !isDeepStrictEqual(fresh.guards, plan.guards)) throw bad('Recovery inputs changed. Review the configuration again.');
      const backupDir = path.join(this.stateDir, 'mcp-recovery-backups');
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      if (!within(await realpath(this.stateDir), await realpath(backupDir)) || (await lstat(backupDir)).isSymbolicLink()) throw bad('Recovery backup folder leaves local Hub state.');
      const undoToken = randomBytes(18).toString('hex'), backup = path.join(backupDir, `${undoToken}.toml`);
      await writeFile(backup, plan.files.length === 1 ? plan.files[0].original : JSON.stringify(plan.files.map(item => ({ file: item.file, source: item.original }))), { flag: 'wx', mode: 0o600 });
      await this.replaceAll(plan, false);
      this.plans.delete(token);
      this.undoPlans.set(undoToken, { ...plan, backup });
      return { saved: true, name: plan.review.name, undoToken, backup, applies: 'Affected chats apply the configuration when safe.' };
    });
  }
  async undo(token) {
    return this.serialize(async () => {
      const plan = this.undoPlans.get(token);
      if (!plan) throw bad('Undo is unavailable in this service session. The private recovery backup is retained.');
      for (const item of plan.files) if (hash(await regular(item.file, item.root)) !== hash(item.next)) throw bad('Configuration changed after recovery. Undo will not overwrite subsequent edits.');
      await this.replaceAll(plan, true);
      this.undoPlans.delete(token);
      return { saved: true, name: plan.review.name };
    });
  }
  async replaceAll(plan, undo) {
    const written = [];
    try {
      for (const item of plan.files) { await this.replace(plan, item, undo ? item.next : item.original, undo ? item.original : item.next); written.push(item); }
    } catch (error) {
      let incomplete = false;
      for (const item of written.reverse()) {
        try { await this.replace(plan, item, undo ? item.original : item.next, undo ? item.next : item.original); }
        catch { incomplete = true; }
      }
      if (incomplete) throw bad('Recovery rollback was incomplete because configuration changed. Private backups are retained; review the affected files manually.');
      throw error;
    }
  }
  serialize(action) { const result = this.pending.catch(() => {}).then(action); this.pending = result; return result; }
}
