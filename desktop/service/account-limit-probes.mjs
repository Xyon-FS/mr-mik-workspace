import { randomUUID } from 'node:crypto';
import { claudeBinary } from './agents.mjs';
import { graphicalCodexBinary } from './codex-chat-binary.mjs';
import { NativeProfileProbe } from './codex-profile-probe.mjs';
import { withCodexStoreStartup } from './codex-profile-layout.mjs';
import { ClaudeRuntime } from './claude-chat-protocol.mjs';
import { claudeChatTransport } from './claude-chat-transport.mjs';
import { planUsage } from './claude-usage.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, 120) : '';
export function codexLimitWindows(value) {
  const buckets = value?.rateLimitsByLimitId && typeof value.rateLimitsByLimitId === 'object' && Object.keys(value.rateLimitsByLimitId).length ? Object.entries(value.rateLimitsByLimitId).slice(0, 20) : value?.rateLimits ? [['codex', value.rateLimits]] : [];
  return buckets.flatMap(([id, bucket]) => [bucket?.primary, bucket?.secondary].filter(Boolean).map(window => {
    const minutes = numeric(window.windowDurationMins), percent = numeric(window.usedPercent), reset = numeric(window.resetsAt);
    const date = reset == null ? NaN : reset * 1000;
    return { label: `${label(bucket.limitName || id)} · ${minutes == null ? 'Usage window' : minutes >= 60 ? `${minutes / 60}h window` : `${minutes}m window`}`, percent: percent !== null && percent <= 100 ? percent : null, resetsAt: Number.isFinite(date) && date <= 8640000000000000 ? new Date(date).toISOString() : null };
  }));
}

// Control-only clients: no thread creation/resume, no user input, no token extraction.
export async function readCodexAccountLimits(context, { signal, createProbe = (cwd, env) => new NativeProfileProbe(cwd, env, { binary: graphicalCodexBinary() }), startup = withCodexStoreStartup } = {}) {
  const read = async () => {
    if (signal?.aborted) throw new Error('Account read cancelled.');
    const probe = createProbe(context.cwd, context.env), abort = () => { void probe.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await probe.initialize();
      const result = await probe.rpc('account/rateLimits/read', {});
      return { windows: codexLimitWindows(result) };
    } finally { signal?.removeEventListener('abort', abort); await probe.close(); }
  };
  return context.sqliteHome ? startup(context.sqliteHome, read) : read();
}

export async function readClaudeAccountLimits(context, { signal, binary = claudeBinary(context.env), transportFactory = claudeChatTransport } = {}) {
  if (signal?.aborted) throw new Error('Account read cancelled.');
  const session = { id: randomUUID(), nativeId: randomUUID(), cwd: context.cwd, agent: 'claude', bypass: false, claudePermissionMode: 'default' };
  // Exclude user/project hook/plugin settings without bare mode, which hides
  // subscription metadata in some CLI versions. Native managed policy remains
  // authoritative. No tools, MCP servers or persistent conversation are created.
  const transport = transportFactory({ session, env: context.env, binary: { file: binary.file, args: [...binary.args, '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-session-persistence'] } });
  const runtime = new ClaudeRuntime(options => {
    const wire = transport.factory(options), send = wire.send.bind(wire);
    wire.send = line => {
      const message = JSON.parse(line);
      if (message.type === 'user' || message.type === 'control_request' && !['initialize', 'get_usage'].includes(message.request?.subtype)) throw new Error('Account inspection permits only native usage controls.');
      return send(line);
    };
    return wire;
  }, { timeoutMs: 15000 });
  const abort = () => runtime.close(); signal?.addEventListener('abort', abort, { once: true });
  try {
    await runtime.connect();
    const usage = await runtime.control({ subtype: 'get_usage', skip_behaviors: true });
    const result = planUsage(usage);
    const unavailable = context.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1' ? 'Online usage is disabled by this Claude environment.' : usage?.rate_limits_available === true ? 'Native subscription usage is temporarily unavailable. Try again shortly.' : 'Subscription limits are unavailable for this native login or CLI version.';
    return { windows: result.windows, note: result.available && result.windows.length ? '' : unavailable };
  } finally { signal?.removeEventListener('abort', abort); runtime.close(); await transport.close(); }
}
