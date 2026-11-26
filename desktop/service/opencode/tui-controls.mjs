// Invocation-only TUI adapter. No HTTP listener, credentials or prompt logging.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';

export const id = 'mr-mik-chat-controls';
export default { id, tui };
export async function tui(api) {
  const file = process.env.MRMAK_OPENCODE_CONTROL;
  const launchId = process.env.MRMAK_OPENCODE_LAUNCH_ID;
  const stateFile = process.env.MRMAK_OPENCODE_STATE;
  if (!file || !launchId || !stateFile || typeof api?.lifecycle?.onDispose !== 'function') return;
  const save = async value => {
    try {
      writeFileSync(`${file}.reply.tmp`, JSON.stringify({ launchId, ...value }), { mode: 0o600 });
      // Windows readers/antivirus may briefly hold the previous receipt open.
      for (let attempt = 0; attempt < 5; attempt++) {
        try { renameSync(`${file}.reply.tmp`, `${file}.reply`); return; }
        catch { await new Promise(resolve => setTimeout(resolve, 30)); }
      }
    } catch { /* Native UI remains usable. Do not replay the action. */ }
  };
  let previous, busy = false;
  try { const saved = JSON.parse(readFileSync(`${file}.processed`, 'utf8')); if (saved.launchId === launchId) previous = saved.id; } catch { /* Fresh launch. */ }
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      if (statSync(file).size > 8192) return;
      const request = JSON.parse(readFileSync(file, 'utf8'));
      if (request.launchId !== launchId || typeof request.id !== 'string' || !request.id || request.id.length > 160 || request.id === previous || !Number.isFinite(request.at) || Date.now() - request.at > 3000 || request.at > Date.now() + 1000) return;
      previous = request.id;
      // Persist consumption before dispatch so plugin reload cannot replay an
      // already admitted command whose reply was lost (notably compaction).
      writeFileSync(`${file}.processed`, JSON.stringify({ launchId, id: request.id }), { mode: 0o600 });
      let observed;
      try { observed = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { observed = { launchId, nativeId: process.env.MRMAK_OPENCODE_SESSION_ID || null }; }
      const route = api.route?.current;
      if (!route || !api.state) return save({ id: request.id, error: 'This OpenCode TUI contract is incompatible. Use the native terminal or update the Mr. Mik adapter.' });
      const home = !observed.nativeId && route.name === 'home';
      if (observed.launchId !== launchId || !home && (route.name !== 'session' || route.params?.sessionID !== observed.nativeId)) return save({ id: request.id, error: 'Return to this Mr. Mik conversation in the native terminal first.' });
      if (request.action === 'controls') {
        const rows = api.keymap?.getCommandEntries?.({ namespace: 'palette', visibility: 'reachable' });
        const list = Array.isArray(rows) ? rows.map(row => row.command) : [];
        return save({ id: request.id, accepted: true, commands: list.filter(row => ['agent.list', 'session.compact'].includes(row.name)).map(row => ({ id: row.name, title: row.title, enabled: typeof row.enabled === 'function' ? row.enabled() : row.enabled !== false })) });
      }
      if (request.action === 'catalog') {
        if (!Array.isArray(api.state.provider)) return save({ id: request.id, error: 'The native model catalog contract is unavailable. Use the terminal.' });
        // Project only public model metadata. Never return provider options/auth/config.
        const models = (api.state.provider || []).flatMap(provider => Object.entries(provider.models || {}).filter(([, model]) => model.status !== 'deprecated').map(([modelID, model]) => ({ providerID: String(provider.id).slice(0, 192), modelID: String(modelID).slice(0, 192), label: String(model.name || modelID).slice(0, 160), provider: String(provider.name || provider.id).slice(0, 100), variants: Object.keys(model.variants || {}).slice(0, 64), contextWindow: Number.isFinite(model.limit?.context) ? model.limit.context : null }))).slice(0, 2048);
        return save({ id: request.id, accepted: true, models });
      }
      if (request.action === 'interrupt') {
        if (home) return save({ id: request.id, error: 'No active native conversation.' });
        if (typeof api.client?.session?.abort !== 'function') return save({ id: request.id, error: 'Native interruption is unavailable. Use the terminal.' });
        const result = await api.client.session.abort({ sessionID: observed.nativeId });
        if (result.error) return save({ id: request.id, error: 'Native interruption failed. Use the terminal.' });
      } else {
        if (!api.ui?.dialog || !home && ['status', 'permission', 'question'].some(name => typeof api.state.session?.[name] !== 'function')) return save({ id: request.id, error: 'Native readiness checks are unavailable. Use the terminal.' });
        const cachedStatus = home ? null : api.state.session.status(observed.nativeId);
        let idle = home || cachedStatus?.type === 'idle';
        // A resumed V1 fork may have no cached execution status yet. Prove its
        // identity and absence from the authoritative active-status map instead
        // of treating unknown UI state as idle.
        if (!home && cachedStatus == null && typeof api.client?.session?.status === 'function' && typeof api.client?.session?.get === 'function') {
          const statusesReply = await api.client.session.status({}), infoReply = await api.client.session.get({ sessionID: observed.nativeId });
          const statuses = statusesReply.data || statusesReply, info = infoReply.data || infoReply;
          idle = !statusesReply.error && !infoReply.error && info.id === observed.nativeId && statuses && typeof statuses === 'object' && !Array.isArray(statuses) && Object.keys(statuses).length <= 10000 && Object.values(statuses).every(value => value && ['idle', 'busy', 'retry'].includes(value.type)) && (!statuses[observed.nativeId] || statuses[observed.nativeId].type === 'idle') && api.route.current?.name === 'session' && api.route.current.params?.sessionID === observed.nativeId && (api.state.session.status(observed.nativeId) == null || api.state.session.status(observed.nativeId)?.type === 'idle');
        }
        if (!api.state.ready || api.ui.dialog.open || !idle || !home && (api.state.session.permission(observed.nativeId).length || api.state.session.question(observed.nativeId).length)) return save({ id: request.id, error: 'Finish native dialogs and wait for a verified idle chat first.' });
        if (request.action === 'message-fork') {
          if (home || typeof api.client?.session?.fork !== 'function' || request.before !== undefined && !/^msg[a-zA-Z0-9_-]{1,160}$/.test(request.before)) return save({ id: request.id, error: 'Native message fork is unavailable.' });
          const result = await api.client.session.fork({ sessionID: observed.nativeId, ...(request.before ? { messageID: request.before } : {}) });
          if (result.error || !/^ses[a-zA-Z0-9_-]{1,160}$/.test(result.data?.id || '') || result.data.id === observed.nativeId) return save({ id: request.id, error: 'Native fork identity was not confirmed. Inspect History; do not retry automatically.' });
          return save({ id: request.id, accepted: true, nativeId: result.data.id });
        }
        if (['mcp-ready', 'mcp-refresh', 'prepare', 'context', 'agent', 'compact'].includes(request.action)) {
          // Read only an empty/non-empty predicate; never log or serialize drafts.
          const prompt = api.renderer?.currentFocusedRenderable;
          if (!prompt || typeof prompt.plainText !== 'string' || prompt.traits?.owner !== 'opencode' || prompt.traits?.role !== 'prompt' || prompt.traits?.status || prompt.traits?.capture?.some(key => key !== 'tab') || prompt.plainText.trim()) return save({ id: request.id, error: 'Focus an empty native prompt before updating MCP connections.' });
          if (request.action === 'prepare') return save({ id: request.id, accepted: true });
          if (request.action === 'context') {
            if (typeof api.keymap?.dispatchCommand !== 'function') return save({ id: request.id, error: 'Native command selector is unavailable. Use the terminal.' });
            api.keymap.dispatchCommand('command.list');
            return save({ id: request.id, accepted: true });
          }
          if (request.action === 'agent') {
            if (typeof api.keymap?.dispatchCommand !== 'function') return save({ id: request.id, error: 'Native agent selector unavailable. Use the terminal.' });
            api.keymap.dispatchCommand('agent.list'); return save({ id: request.id, accepted: true });
          }
          if (request.action === 'compact') {
            const rows = api.keymap?.getCommandEntries?.({ namespace: 'palette', visibility: 'reachable' });
            if (home || !Array.isArray(rows) || !rows.some(row => row.command?.name === 'session.compact') || typeof api.keymap?.dispatchCommand !== 'function') return save({ id: request.id, error: 'Native compaction is unavailable. Use the terminal.' });
            api.keymap.dispatchCommand('session.compact'); return save({ id: request.id, accepted: true });
          }
          if (request.action === 'mcp-ready') return save({ id: request.id, accepted: true, mcpRefreshAvailable: ['connect', 'disconnect', 'status'].every(name => typeof api.client?.mcp?.[name] === 'function') });
          const changes = request.changes;
          if (!Array.isArray(changes) || !changes.length || changes.length > 32 || changes.some(item => !item || !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(item.name) || item.name === 'mrmak_workspace' || typeof item.enabled !== 'boolean') || new Set(changes.map(item => item.name)).size !== changes.length) return save({ id: request.id, error: 'Invalid MCP update request.' });
          const mcp = api.client?.mcp;
          if (!mcp || ['connect', 'disconnect', 'status'].some(name => typeof mcp[name] !== 'function')) return save({ id: request.id, error: 'Native MCP refresh is unavailable. Reconnect the chat manually.' });
          const signal = AbortSignal.timeout(20000);
          for (const item of changes) {
            if (api.ui.dialog.open || prompt.plainText.trim() || !home && api.state.session.status(observed.nativeId)?.type !== 'idle') return save({ id: request.id, error: 'The chat changed during MCP refresh. Inspect it before retrying.' });
            if (signal.aborted) return save({ id: request.id, error: 'MCP update timed out. Check native connection status before retrying.' });
            const result = await mcp[item.enabled ? 'connect' : 'disconnect']({ name: item.name }, { signal });
            if (result?.error) return save({ id: request.id, error: 'MCP update failed. Check the native connection status.' });
          }
          const result = await mcp.status({}, { signal });
          if (!result?.data || result.error || changes.some(item => item.enabled ? result.data[item.name]?.status !== 'connected' : result.data[item.name] && result.data[item.name].status !== 'disabled')) return save({ id: request.id, error: 'MCP connection status was not confirmed. Check the terminal.' });
          return save({ id: request.id, accepted: true });
        }
        const command = { model: 'model.list', variant: 'variant.list', submit: 'prompt.submit' }[request.action];
        if (!command && request.action !== 'prepare') return save({ id: request.id, error: 'Unsupported chat control.' });
        if (command) {
          if (typeof api.keymap?.dispatchCommand !== 'function') return save({ id: request.id, error: 'Native command dispatch is unavailable. Use the terminal.' });
          api.keymap.dispatchCommand(command);
        }
      }
      await save({ id: request.id, accepted: true });
    } catch { /* Missing request/observer during startup is normal. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void poll(), 80);
  await save({ ready: true });
  api.lifecycle.onDispose(() => clearInterval(timer));
}
