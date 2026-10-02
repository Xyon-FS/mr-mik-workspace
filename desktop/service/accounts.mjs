import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
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
async function readAccountStatus(agent, resolve) {
  try {
    const command = accountStatusCommand(agent, resolve);
    let result;
    try { const value = await execute(command.file, command.args, { windowsHide: true, timeout: 12000, maxBuffer: 32768, env: { ...childEnvironment(), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' } }); result = { code: 0, ...value }; }
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
export async function openAccountTerminal(command) {
  if (process.platform !== 'win32') throw new Error('Native account terminals currently require Windows.');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$Host.UI.RawUI.WindowTitle = 'Mr. Mik - Native account'; & ${[command.file, ...command.args].map(quote).join(' ')}; Write-Host 'Native account command finished. Close this window and reopen your chats in Mr. Mik.'`;
  // Visible only after the user's explicit "Open native ..." confirmation.
  // Never capture output, read auth files, or save authentication in History.
  // Start-Process allocates its own visible console without output redirection.
  // The hidden launcher must not leave the auth child with NUL/inherited pipes.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launch = `try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${encoded}') -WindowStyle Normal -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }`;
  try { await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 4096, env: childEnvironment() }); }
  catch { throw new Error('Native account terminal could not be opened. No authentication output is collected.'); }
  return { requested: true };
}
export class Accounts {
  constructor({ blocked = () => false, resolve, launch = openAccountTerminal, status = readAccountStatus } = {}) { this.blocked = blocked; this.resolve = resolve; this.launch = launch; this.status = status; this.plans = new Map(); }
  async inventory() { return Promise.all(Object.entries(labels).map(async ([agent, label]) => { try { accountCommand(agent, 'login', this.resolve); const result = await this.status(agent, this.resolve); return { agent, label, available: true, ...(agent === 'opencode' && typeof result === 'object' ? result : { status: result }) }; } catch { return { agent, label, available: false, status: 'unknown' }; } })); }
  plan(agent, action, provider = '') {
    const command = accountCommand(agent, action, this.resolve, provider);
    if (this.blocked(agent)) throw new Error('Close this agent’s Mr. Mik chat tabs and wait for Mik before changing its native account. Other applications using this profile should be closed too.');
    for (const [key, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(key);
    if (this.plans.size >= 16) this.plans.clear();
    const token = randomUUID(); this.plans.set(token, { agent, action, provider, command, expires: Date.now() + 120000 });
    return { token, agent, action, label: labels[agent] + (agent === 'opencode' && provider ? ` · ${provider}` : '') };
  }
  async confirm(token) {
    const plan = this.plans.get(token); this.plans.delete(token);
    if (!plan || plan.expires < Date.now()) throw new Error('Account confirmation expired. Try again.');
    if (this.blocked(plan.agent)) throw new Error('Close this agent’s chat tabs before changing its account.');
    if (JSON.stringify(accountCommand(plan.agent, plan.action, this.resolve, plan.provider)) !== JSON.stringify(plan.command)) throw new Error('Native CLI changed. Review the account action again.');
    return this.launch(plan.command);
  }
}
