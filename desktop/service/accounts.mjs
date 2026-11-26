import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { codexBinary, claudeBinary, openCodeBinary, childEnvironment } from './agents.mjs';
import { openCodeVersion } from './opencode.mjs';

const labels = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode' };
const providerId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
// Project only provider identities and connection kinds, never credentials,
// account labels, environment names or the raw native response.
export function parseOpenCodeProviders({ code, stdout = '' }) {
  if (code !== 0) return { status: 'unknown', providers: [] };
  try {
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows) || !rows.every(row => providerId(row?.id) && Array.isArray(row.connections))) return { status: 'unknown', providers: [] };
    const providers = rows.filter(row => row.connections.length).map(row => ({ provider: row.id, label: row.id, status: 'logged-in', canLogout: row.connections.some(connection => connection.type === 'credential') }));
    return { status: providers.length ? 'logged-in' : 'logged-out', providers };
  } catch { /* V1 reports display names, not reliable provider IDs. */ }
  const text = stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  if (!/\bcredentials?\b/i.test(text)) return { status: 'unknown', providers: [] };
  const providers = [...text.matchAll(/^[^\w\r\n]*([A-Za-z][A-Za-z0-9 ._-]{0,79}?)\s+(?:oauth|api)\s*$/gmi)].map(match => ({ provider: '', label: match[1].trim(), status: 'logged-in', canLogout: true }));
  return { status: providers.length ? 'logged-in' : /\b0 credentials?\b/i.test(text) ? 'logged-out' : 'unknown', providers };
}
const execute = promisify(execFile);
const accountFamily = resolve => resolve?.openCodeFamily ? resolve.openCodeFamily() : resolve?.opencode === openCodeBinary ? Number(openCodeVersion().split('.')[0]) >= 2 ? 2 : 1 : 1;
export function accountStatusCommand(agent, resolve = { codex: codexBinary, claude: claudeBinary, opencode: openCodeBinary }) {
  const command = accountCommand(agent, 'login', resolve);
  const args = agent === 'codex' ? ['login', 'status'] : agent === 'claude' ? ['auth', 'status', '--json'] : accountFamily(resolve) === 2 ? ['auth', 'list', '--standalone', '--format', 'json'] : ['auth', 'list', '--pure'];
  return { file: command.file, args: [...resolve[agent]().args, ...args] };
}
export function parseAccountStatus(agent, { code, stdout = '', stderr = '' }) {
  if (agent === 'codex') return code === 0 ? 'logged-in' : code === 1 && /not logged in/i.test(stdout + stderr) ? 'logged-out' : 'unknown';
  if (agent === 'claude') { try { const value = JSON.parse(stdout); return typeof value.loggedIn === 'boolean' ? value.loggedIn ? 'logged-in' : 'logged-out' : 'unknown'; } catch { return 'unknown'; } }
  if (agent === 'opencode') return parseOpenCodeProviders({ code, stdout }).status;
  return 'unknown';
}
async function readAccountStatus(agent, resolve, env = childEnvironment()) {
  try {
    const command = accountStatusCommand(agent, resolve);
    let result;
    try { const value = await execute(command.file, command.args, { windowsHide: true, timeout: 12000, maxBuffer: 32768, env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' } }); result = { code: 0, ...value }; }
    catch (error) { result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
    // Return only a fixed enum or safe provider projection. No raw native output.
    return agent === 'opencode' ? parseOpenCodeProviders(result) : parseAccountStatus(agent, result);
  } catch { return 'unknown'; }
}
export function accountCommand(agent, action, resolve = { codex: codexBinary, claude: claudeBinary, opencode: openCodeBinary }, provider = '') {
  if (!Object.hasOwn(labels, agent) || !['login', 'logout'].includes(action)) throw new Error('Unsupported native account action.');
  const binary = resolve[agent]();
  if (!binary.file || /\.(cmd|bat|ps1)$/i.test(binary.file)) throw new Error('A native CLI executable is required for account management.');
  if (agent === 'opencode' && provider && !providerId(provider)) throw new Error('Unsupported provider identity.');
  const args = agent === 'codex' ? [action] : agent === 'claude' ? ['auth', action] : accountFamily(resolve) === 2 ? ['auth', action, ...(provider ? [provider] : []), '--standalone'] : action === 'login' ? ['auth', 'login', ...(provider ? ['--provider', provider] : [])] : ['auth', 'logout', ...(provider ? [provider] : [])];
  return { file: binary.file, args: [...binary.args, ...args] };
}
export async function openAccountTerminal(command, env = childEnvironment()) {
  if (process.platform !== 'win32') throw new Error('Native account terminals currently require Windows.');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$Host.UI.RawUI.WindowTitle = 'Mr. Mik - Native account'; & ${[command.file, ...command.args].map(quote).join(' ')}; Write-Host 'Native account command finished. Press Enter to close this window before reopening chats.'; [void][Console]::ReadLine()`;
  // Visible only after the user's explicit "Open native ..." confirmation.
  // Never capture output, read auth files, or save authentication in History.
  // Start-Process allocates its own visible console without output redirection.
  // The hidden launcher must not leave the auth child with NUL/inherited pipes.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launch = `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -WindowStyle Normal -PassThru -ErrorAction Stop; Write-Output $p.Id; exit 0 } catch { exit 1 }`;
  let pid;
  try { const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 4096, env }); pid = Number(result.stdout.trim()); if (!Number.isInteger(pid) || pid <= 0) throw new Error(); }
  catch { throw new Error('Native account terminal could not be opened. No authentication output is collected.'); }
  return { requested: true, pid };
}
// Legacy native account commands keep their console/output out of the UI,
// logs and Hub. Codex login uses the separate private-browser flow below.
export async function runHiddenAccountCommand(command, env = childEnvironment(), { onStart, signal, spawnProcess = spawn, timeoutMs = 180000 } = {}) {
  const child = spawnProcess(command.file, command.args, { env, windowsHide: true, shell: false, stdio: 'ignore', signal });
  let timedOut = false, timer;
  const closed = new Promise(resolve => child.once('close', resolve));
  const finished = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(signal?.aborted ? 'Native sign-in cancelled.' : 'Native account command could not start. Check the CLI installation and retry.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(timedOut ? 'Native sign-in timed out. Connect the account again to retry.' : 'Native account command did not complete. Retry the browser sign-in or check the CLI configuration.')));
  });
  // A spawn failure can arrive before the asynchronous cross-service lock write.
  finished.catch(() => {});
  timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    if (Number.isInteger(child.pid) && child.pid > 0) await onStart?.(child.pid);
    await finished;
    return { requested: true, completed: true };
  } catch (error) {
    child.kill(); await closed; throw error;
  } finally { clearTimeout(timer); }
}
const launchAccountCommand = async (command, env, options) => options?.privateLogin
  ? (await import('./codex-private-login.mjs')).runPrivateCodexLogin(command, env, options)
  : options?.silent ? runHiddenAccountCommand(command, env, options) : openAccountTerminal(command, env);
export class Accounts {
  constructor({ blocked = () => false, resolve, launch = launchAccountCommand, status = readAccountStatus, profiles, claudeProfiles, beforeChange = async () => {} } = {}) { this.blocked = blocked; this.resolve = resolve; this.launch = launch; this.status = status; this.profiles = profiles; this.claudeProfiles = claudeProfiles; this.beforeChange = beforeChange; this.plans = new Map(); this.terminals = new Map(); this.changing = new Set(); this.pending = new Set(); }
  async close() { this.closed = true; this.plans.clear(); const pending = [...this.pending]; for (const item of pending) item.controller.abort(); await Promise.all(pending.map(item => item.done)); await Promise.allSettled([...(this.displayTasks || [])]); }
  displayInventory(agent, read) {
    if (this.closed) return Promise.reject(new Error('Mr. Mik is shutting down.'));
    this.displayReads ||= new Map();
    this.displayTasks ||= new Set();
    if (this.displayReads.has(agent)) return this.displayReads.get(agent);
    const pending = read().finally(() => { this.displayTasks.delete(pending); if (this.displayReads.get(agent) === pending) this.displayReads.delete(agent); });
    this.displayReads.set(agent, pending); this.displayTasks.add(pending); return pending;
  }
  invalidateDisplay(agent) { if (agent) this.displayReads?.delete(agent); else this.displayReads?.clear(); }
  async readProfileRows(rows, read) {
    const result = new Array(rows.length); let next = 0;
    // A large registry must not spawn one native CLI per account at once.
    await Promise.all(Array.from({length: Math.min(4, rows.length)}, async () => {
      while (next < rows.length) {
        const index = next++, row = rows[index];
        result[index] = this.closed ? { ...row, status: 'unknown', available: false } : await read(row);
      }
    }));
    return result;
  }
  terminalOpen(agent, profileId = 'system') {
    if (this.changing.has(`${agent}:${profileId}`)) return true;
    const key = `${agent}:${profileId}`, pid = this.terminals.get(key);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') return true; this.terminals.delete(key); return false; }
  }
  profileResolver(context) {
    return { ...(this.resolve || { codex: codexBinary, claude: claudeBinary, opencode: openCodeBinary }), claude: () => (this.resolve?.claude || claudeBinary)(context.env), codex: () => {
      const binary = (this.resolve?.codex || codexBinary)(context.env);
      return context.system ? binary : { ...binary, args: [...binary.args, '-c', 'cli_auth_credentials_store="file"'] };
    } };
  }
  profileInventory() { return this.displayInventory('codex', () => this.readProfileInventory()); }
  async readProfileInventory() {
    const action = await this.profiles.accountAction();
    const identities = await this.profiles.identityStates();
    return this.readProfileRows((await this.profiles.list()).filter(row => !row.system), async row => {
      try { const context = await this.profiles.statusContext(row.id); const status = await this.status('codex', this.profileResolver(context), context.env); return { ...row, ...identities.find(item => item.id === row.id), status, available: true, accountTerminalOpen: action?.profileId === row.id || this.terminalOpen('codex', row.id) }; }
      catch { return { ...row, status: 'unknown', available: false }; }
    });
  }
  async profilePlan(profileId, action, { disconnect = false } = {}) {
    if (await this.profiles.accountAction()) throw new Error('Finish the other Codex account action first.');
    const context = await this.profiles.context(profileId);
    const plan = this.plan('codex', action, '', context);
    if (disconnect && action === 'logout' && !context.system) this.plans.get(plan.token).disconnect = true;
    return { ...plan, profileId: context.profileId, isolated: !context.system, label: `Codex · ${context.label}` };
  }
  claudeInventory() { return this.displayInventory('claude', () => this.readClaudeInventory()); }
  async readClaudeInventory() {
    return this.readProfileRows(await this.claudeProfiles.list(), async row => {
      try { const context = await this.claudeProfiles.context(row.id), identity = await this.claudeProfiles.identity(context.env); return { ...row, status: identity.status, identityEmail: identity.email || null, available: true, accountTerminalOpen: this.terminalOpen('claude', row.id) }; }
      catch { return { ...row, status: 'unknown', available: false }; }
    });
  }
  async claudePlan(profileId, action) {
    if (await this.claudeProfiles.accountAction()) throw new Error('Finish the other Claude account action first.');
    const context = await this.claudeProfiles.context(profileId || 'system');
    return { ...this.plan('claude', action, '', context), profileId: context.profileId, isolated: !context.system, label: `Claude · ${context.label}` };
  }
  async inventory(selected) {
    if (selected && !Object.hasOwn(labels, selected)) throw new Error('Unsupported account provider.');
    return Promise.all(Object.entries(labels).filter(([agent]) => !selected || selected === agent).map(async ([agent, label]) => { try { accountCommand(agent, 'login', this.resolve); const result = await this.status(agent, this.resolve); return { agent, label, available: true, ...(agent === 'opencode' && typeof result === 'object' ? result : { status: result }) }; } catch { return { agent, label, available: false, status: 'unknown' }; } }));
  }
  plan(agent, action, provider = '', context) {
    if (this.closed) throw new Error('Mr. Mik is shutting down.');
    const profileId = context?.profileId || 'system';
    const command = accountCommand(agent, action, context ? this.profileResolver(context) : this.resolve, provider);
    if (this.blocked(agent, profileId) || this.terminalOpen(agent, profileId)) throw new Error('Close this profile’s chat tabs and native account terminal before changing its account. Other profiles can keep working.');
    if (action === 'login' && [...this.terminals.keys()].some(key => key.startsWith(`${agent}:`) && this.terminalOpen(agent, key.slice(agent.length + 1)))) throw new Error('Finish the other native login and close its terminal before starting another login.');
    for (const [key, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(key);
    if (this.plans.size >= 16) this.plans.clear();
    const token = randomUUID(); this.plans.set(token, { agent, action, provider, profileId, context, command, expires: Date.now() + 120000 });
    return { token, agent, action, label: labels[agent] + (agent === 'opencode' && provider ? ` · ${provider}` : '') };
  }
  async confirm(token) {
    if (this.closed) throw new Error('Mr. Mik is shutting down.');
    const plan = this.plans.get(token); this.plans.delete(token);
    if (!plan || plan.expires < Date.now()) throw new Error('Account confirmation expired. Try again.');
    if (this.blocked(plan.agent, plan.profileId) || this.terminalOpen(plan.agent, plan.profileId)) throw new Error('Close this profile’s chat tabs and native account terminal before changing its account.');
    if ([...this.changing].some(key => key.startsWith(`${plan.agent}:`))) throw new Error('Another native account action is starting. Finish it before changing accounts.');
    if (plan.action === 'login' && [...this.terminals.keys()].some(key => key.startsWith(`${plan.agent}:`) && this.terminalOpen(plan.agent, key.slice(plan.agent.length + 1)))) throw new Error('Finish the other login first.');
    const key = `${plan.agent}:${plan.profileId}`; this.changing.add(key); this.displayReads?.delete(plan.agent);
    let finish;
    const pending = { controller: new AbortController(), done: new Promise(resolve => { finish = resolve; }) }; this.pending.add(pending);
    let reservation;
    try {
      if (this.profiles && plan.agent === 'codex') reservation = await this.profiles.reserveAccountAction(plan.profileId);
      if (this.claudeProfiles && plan.agent === 'claude') reservation = await this.claudeProfiles.reserveAccountAction(plan.profileId);
      const manager = plan.agent === 'claude' ? this.claudeProfiles : this.profiles;
      const context = plan.context ? await manager.context(plan.profileId) : null;
      if (context && (context.configRevision !== plan.context.configRevision || context.conversationStoreId !== plan.context.conversationStoreId)) throw new Error('Profile configuration changed. Review the account action again.');
      if (JSON.stringify(accountCommand(plan.agent, plan.action, context ? this.profileResolver(context) : this.resolve, plan.provider)) !== JSON.stringify(plan.command)) throw new Error('Native CLI changed. Review the account action again.');
      await this.beforeChange(plan.agent, plan.profileId);
      if (this.closed) throw new Error('Mr. Mik is shutting down.');
      if (this.blocked(plan.agent, plan.profileId)) throw new Error('A chat started before the account change. Close it and review again.');
      const result = await this.launch(plan.command, context?.env, { privateLogin: plan.agent === 'codex' && plan.action === 'login', silent: ['codex', 'claude'].includes(plan.agent), signal: pending.controller.signal, onStart: async pid => { if (reservation) await reservation(pid, true); } });
      if (plan.agent === 'claude' && context && result?.completed) {
        const status = await this.claudeProfiles.identity(context.env);
        if (status.status !== (plan.action === 'login' ? 'logged-in' : 'logged-out')) throw new Error('Claude account action could not be verified. Refresh its account status before retrying.');
      }
      if (plan.agent === 'codex' && context && !context.system && result?.completed) {
        if (plan.action === 'login') await this.profiles.bindIdentity(plan.profileId);
        else if (await this.status('codex', this.profileResolver(context), context.env) !== 'logged-out') throw new Error('Codex logout could not be verified. This profile has not been removed. Check its account status and try again.');
      }
      if (plan.disconnect) await this.profiles.remove(plan.profileId);
      if (result?.pid) this.terminals.set(`${plan.agent}:${plan.profileId}`, result.pid);
      if (reservation) { await reservation(result?.pid); reservation = null; }
      return { requested: true, ...(result?.completed ? { completed: true } : {}) };
    } finally { try { if (reservation) await reservation(); } finally { this.displayReads?.delete(plan.agent); this.changing.delete(key); this.pending.delete(pending); finish(); } }
  }
}
