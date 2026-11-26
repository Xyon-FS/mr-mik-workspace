// Public metadata/receipts only: never serialize drafts, auth or provider options.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { publicV2Skills } from '../opencode-v2-skills.mjs';

export async function handleV2Control(api, request, observed, launchId, active = () => true) {
  const fail = error => ({ id: request.id, error });
  const route = api.ui?.router?.current?.();
  const home = route?.type === 'home' && observed?.hasConversation === false && typeof api.data?.session?.get === 'function' && !api.data.session.get(observed.nativeId);
  if (!active() || observed?.launchId !== launchId || !observed.nativeId || !home && (route?.type !== 'session' || route.sessionID !== observed.nativeId)) return fail('Return to this Mr. Mik conversation in the native terminal first.');
  const sessionID = observed.nativeId;
  if (request.action === 'controls') {
    return { id: request.id, accepted: true, commands: (api.keymap?.commands?.() || []).filter(row => ['agent.list', 'session.compact'].includes(row.id)).map(row => ({ id: row.id, title: row.title, enabled: typeof row.enabled === 'function' ? row.enabled() : row.enabled !== false })) };
  }
  if (request.action === 'skills') {
    if (typeof api.client?.skill?.list !== 'function') return fail('The native V2 skill inventory is unavailable.');
    const reply = await api.client.skill.list({ location: api.location });
    if (!active()) return fail('Native V2 skill inspection expired.');
    return { id: request.id, accepted: true, skills: publicV2Skills(reply?.data) };
  }
  if (request.action === 'plugins') {
    if (typeof api.client?.plugin?.list !== 'function') return fail('The native V2 plugin inventory is unavailable.');
    const reply = await api.client.plugin.list({ location: api.location });
    if (!active() || !Array.isArray(reply?.data) || reply.data.length > 512) return fail('The native V2 plugin inventory was not recognized.');
    return { id: request.id, accepted: true, plugins: reply.data.filter(item => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(item.id || '') && ['local', 'package'].includes(item.source?.type)).map(item => ({
      id: item.id, source: item.source.type === 'local' ? { type: 'local', path: item.source.path } : { type: 'package', target: item.source.target },
      status: item.state?.status === 'active' ? 'active' : 'failed',
    })).filter(item => typeof (item.source.path || item.source.target) === 'string' && (item.source.path || item.source.target).length < 2048 && !/[\r\n]/.test(item.source.path || item.source.target) && !/https?:.*[?@#]/i.test(item.source.target || '')) };
  }
  if (request.action === 'catalog') {
    const location = api.location ?? api.data?.location?.default?.();
    const models = api.data?.location?.model?.list?.(location), providers = api.data?.location?.provider?.list?.(location);
    if (!Array.isArray(models) || !Array.isArray(providers)) return fail('The native V2 model catalog is unavailable. Use the terminal.');
    return { id: request.id, accepted: true, models: models.filter(model => model.enabled !== false && model.status !== 'deprecated').slice(0, 2048).map(model => ({ providerID: String(model.providerID).slice(0, 192), modelID: String(model.id).slice(0, 192), label: String(model.name || model.id).slice(0, 160), provider: String(providers.find(provider => provider.id === model.providerID)?.name || model.providerID).slice(0, 100), variants: (model.variants || []).map(item => String(item.id)).slice(0, 64), contextWindow: Number.isFinite(model.limit?.context) ? model.limit.context : null })) };
  }
  if (request.action === 'interrupt') {
    if (home) return fail('No active native conversation.');
    if (typeof api.client?.session?.interrupt !== 'function') return fail('Native V2 interruption is unavailable. Use the terminal.');
    await api.client.session.interrupt({ sessionID });
    return { id: request.id, accepted: true };
  }
  const data = api.data?.session;
  if (!data || typeof data.status !== 'function' || typeof data.permission?.sync !== 'function' || typeof data.form?.sync !== 'function') return fail('Native V2 readiness checks are unavailable. Use the terminal.');
  if (!home) { await data.permission.sync(sessionID); await data.form.sync(sessionID, api.location); }
  const permission = home ? [] : data.permission.list(sessionID), forms = home ? [] : data.form.list(sessionID, api.location), prompt = api.renderer?.currentFocusedRenderable;
  if (!active() || !home && data.status(sessionID) !== 'idle' || !Array.isArray(permission) || !Array.isArray(forms) || permission.length || forms.length || (home ? api.ui.router.current()?.type !== 'home' : api.ui.router.current()?.sessionID !== sessionID)) return fail('Finish native dialogs and wait for an idle chat first.');
  if (request.action === 'message-fork') {
    if (home || typeof api.client?.session?.fork !== 'function' || request.before !== undefined && !/^msg[a-zA-Z0-9_-]{1,160}$/.test(request.before)) return fail('Native V2 message fork is unavailable.');
    const reply = await api.client.session.fork({ sessionID, ...(request.before ? { before: request.before } : {}) });
    const created = reply.data || reply;
    if (reply.error || !/^ses[a-zA-Z0-9_-]{1,160}$/.test(created?.id || '') || created.id === sessionID) return fail('Native fork identity was not confirmed. Inspect History; do not retry automatically.');
    return { id: request.id, accepted: true, nativeId: created.id };
  }
  if (!prompt || typeof prompt.plainText !== 'string' || prompt.traits?.owner !== 'opencode' || prompt.traits?.role !== 'prompt' || prompt.traits?.status || prompt.traits?.capture?.some(key => key !== 'tab')) return fail('Focus the native prompt and finish dialogs or autocomplete first.');
  if (request.action === 'restore-agent') {
    if (home || prompt.plainText.trim() || !['build', 'plan'].includes(request.agent) || typeof api.client?.session?.switchAgent !== 'function' || typeof api.client?.session?.get !== 'function') return fail('Native agent restoration is unavailable.');
    await api.client.session.switchAgent({ sessionID, agent: request.agent });
    const response = await api.client.session.get({ sessionID }), info = response.data || response;
    if (info.agent !== request.agent) return fail('Native agent was not confirmed.');
    return { id: request.id, accepted: true };
  }
  if (request.action === 'restore-model') {
    if (home || prompt.plainText.trim() || typeof api.client?.session?.switchModel !== 'function' || typeof api.client?.session?.get !== 'function' || ['providerID', 'modelID'].some(key => typeof request[key] !== 'string' || !request[key] || request[key].length > 192) || request.variant !== undefined && (typeof request.variant !== 'string' || request.variant.length > 64)) return fail('Native model restoration is unavailable.');
    const model = { id: request.modelID, providerID: request.providerID, ...(request.variant ? { variant: request.variant } : {}) };
    await api.client.session.switchModel({ sessionID, model });
    const response = await api.client.session.get({ sessionID }), actual = (response.data || response).model;
    if (actual?.id !== model.id || actual?.providerID !== model.providerID || (actual?.variant || 'default') !== (model.variant || 'default')) return fail('Native model/variant was not confirmed.');
    return { id: request.id, accepted: true };
  }
  if (['prepare', 'mcp-ready'].includes(request.action)) {
    if (prompt.plainText.trim()) return fail('Focus an empty native prompt before updating or sending a task.');
    return { id: request.id, accepted: true, mcpRefreshAvailable: false };
  }
  if (['context', 'agent', 'compact'].includes(request.action) && prompt.plainText.trim()) return fail('Focus an empty native prompt before opening native selectors.');
  const command = { model: 'model.list', variant: 'variant.list', submit: 'prompt.submit', context: 'prompt.skills', agent: 'agent.list', compact: !home ? 'session.compact' : null }[request.action];
  if (!command) return fail('Unsupported V2 chat control.');
  if (request.action === 'submit' && !prompt.plainText.trim()) return fail('The native prompt is empty.');
  if (typeof api.keymap?.dispatch !== 'function' || typeof api.keymap?.commands !== 'function' || !api.keymap.commands().some(item => item.id === command && (typeof item.enabled === 'function' ? item.enabled() : item.enabled !== false))) return fail('This native V2 command is unavailable. Use the terminal.');
  api.keymap.dispatch(command);
  return { id: request.id, accepted: true };
}

export default {
  id: 'mr-mik-chat-controls-v2',
  async setup(api) {
    const file = process.env.MRMAK_OPENCODE_CONTROL, launchId = process.env.MRMAK_OPENCODE_LAUNCH_ID, stateFile = process.env.MRMAK_OPENCODE_STATE;
    if (!file || !launchId || !stateFile) return;
    const save = async value => {
      try {
        writeFileSync(`${file}.reply.tmp`, JSON.stringify({ launchId, ...value }), { mode: 0o600 });
        for (let i = 0; i < 5; i++) { try { renameSync(`${file}.reply.tmp`, `${file}.reply`); return; } catch { await new Promise(resolve => setTimeout(resolve, 30)); } }
      } catch { /* Never replay an action when its receipt cannot be saved. */ }
    };
    if (typeof api.storage?.memory !== 'function') throw new Error('Mr. Mik requires the native V2 ephemeral control receipt contract.');
    // A plugin hot reload must not execute the still-present request twice.
    // Memory survives reloads, but is not persisted to disk or exported.
    const [memory, update] = api.storage.memory(`controls.${launchId}`, { initial: { previous: null, busy: false } });
    let disposed = false;
    const poll = async () => {
      if (memory.busy || disposed) return;
      update(value => { value.busy = true; });
      let request;
      try {
        if (statSync(file).size > 8192) return;
        request = JSON.parse(readFileSync(file, 'utf8'));
        if (request.launchId !== launchId || typeof request.id !== 'string' || !request.id || request.id.length > 160 || request.id === memory.previous || !Number.isFinite(request.at) || Date.now() - request.at > 3000 || request.at > Date.now() + 1000) return;
        update(value => { value.previous = request.id; });
        const state = JSON.parse(readFileSync(stateFile, 'utf8'));
        await save(await handleV2Control(api, request, state, launchId, () => !disposed && Date.now() - request.at <= 3000));
      } catch {
        if (request?.id === memory.previous) await save({ id: request.id, error: 'Native V2 control could not be confirmed. Inspect the terminal before retrying.' });
      } finally { update(value => { value.busy = false; }); }
    };
    const timer = setInterval(() => void poll(), 80);
    await save({ ready: true });
    return () => { disposed = true; clearInterval(timer); };
  },
};
