// Inspection projection only. Original JSONC is never migrated wholesale.
export const hasV2Config = value => value?.mcp?.servers && !value.mcp.servers.type || Array.isArray(value?.permissions) || Array.isArray(value?.plugins) || Array.isArray(value?.skills);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function openCodeServers(value, family = 1) {
  const mcp = object(value?.mcp), servers = {};
  if (mcp.servers != null && !mcp.servers.type && (typeof mcp.servers !== 'object' || Array.isArray(mcp.servers))) throw new Error('Invalid native V2 MCP server map.');
  for (const [name, definition] of Object.entries(mcp)) {
    if (['servers', 'timeout'].includes(name) && !definition?.type) continue;
    if (family === 2 && definition && Object.keys(definition).every(key => key === 'enabled')) continue;
    servers[name] = definition;
  }
  for (const [name, definition] of Object.entries(object(mcp.servers?.type ? null : mcp.servers))) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) || !['local', 'remote'].includes(definition.type) || definition.type === 'local' && !Array.isArray(definition.command) || definition.type === 'remote' && typeof definition.url !== 'string') throw new Error('Invalid native V2 MCP definition.');
    const { disabled, ...rest } = definition;
    servers[name] = { ...rest, ...(typeof disabled === 'boolean' ? { enabled: !disabled } : {}) };
  }
  return servers;
}
export const configView = (value, family) => ({ ...value, mcp: openCodeServers(value, family) });
export function safeInheritedV2Server(definition) {
  const reference = value => typeof value === 'string' && /\{(?:env|file):[^{}]+\}/.test(value);
  const sensitive = /api[-_]?key|token|password|secret|authorization|auth/i;
  for (const value of Object.values(definition.headers || {})) if (!reference(value)) throw new Error('Inherited MCP headers contain literal values. Use environment references or define this project explicitly.');
  for (const [key, value] of Object.entries(definition.environment || {})) if (sensitive.test(key) && !reference(value)) throw new Error('Inherited MCP environment may contain credentials. Use environment references or define this project explicitly.');
  for (const [key, value] of Object.entries(definition.oauth || {})) if (/secret/i.test(key) && !reference(value)) throw new Error('Inherited MCP OAuth may contain credentials. Define this project explicitly.');
  const command = definition.command || [];
  if (command.some((arg, index) => sensitive.test(arg) && !reference(arg) && !reference(command[index + 1]))) throw new Error('Inherited MCP command may contain credentials. Use environment references or define this project explicitly.');
  if (definition.type === 'remote') { const url = new URL(definition.url); if (url.username || url.password || url.search || url.hash) throw new Error('Inherited MCP URL may contain credentials. Define a credential-free project URL explicitly.'); }
  const { enabled, ...rest } = definition;
  const result = { ...rest, ...(typeof enabled === 'boolean' ? { disabled: !enabled } : {}) };
  if (typeof result.timeout === 'number') result.timeout = { catalog: result.timeout, execution: result.timeout };
  if (result.oauth && typeof result.oauth === 'object') {
    const { clientId, clientSecret, redirectUri, ...oauth } = result.oauth;
    result.oauth = { ...oauth, ...(clientId !== undefined ? { client_id: clientId } : {}), ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}) };
    if (redirectUri) throw new Error('Legacy OAuth redirect configuration needs explicit V2 review before copying.');
  }
  return result;
}
export function skillRules(value) {
  const legacy = value?.permission?.skill;
  const rules = typeof value?.permission === 'string' ? [{ resource: '*', effect: value.permission }] : typeof legacy === 'string' ? [{ resource: '*', effect: legacy }] : Object.entries(object(legacy)).map(([resource, effect]) => ({ resource, effect }));
  if (value?.permissions != null && (!Array.isArray(value.permissions) || value.permissions.some(rule => !rule || typeof rule.action !== 'string' || typeof rule.resource !== 'string' || !['allow', 'deny', 'ask'].includes(rule.effect)))) throw new Error('Invalid native V2 permission rules.');
  return [...rules, ...(value?.permissions || []).filter(rule => rule.action === 'skill' || rule.action === '*')];
}
export function skillSetting(layers, name, exact = false, raw = false) {
  let effect = null;
  for (const layer of layers) for (const rule of skillRules(layer.value)) {
    const pattern = '^' + rule.resource.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$';
    if (exact ? rule.resource === name : new RegExp(pattern).test(name)) effect = rule.effect;
  }
  return raw ? effect : effect === 'deny' ? false : effect === 'allow' ? true : null;
}
