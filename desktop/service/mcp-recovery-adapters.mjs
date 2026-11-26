import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { openCodeLayers, mergeOpenCode, openCodeConfigDir } from './opencode-settings.mjs';
import { openCodeServers, hasV2Config } from './opencode-config-view.mjs';
import { McpInventory } from './mcp.mjs';

const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const canonical = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
function document(source, strict = false) {
  try { if (strict) return JSON.parse(source); } catch { fail('Native JSON configuration is malformed. Repair it before recovery.'); }
  const errors = [], value = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) fail('Native JSON/JSONC configuration is malformed. Repair it before recovery.');
  return value;
}
function remove(source, keys, strict) {
  const before = document(source, strict), expected = structuredClone(before);
  let owner = expected;
  for (const key of keys.slice(0, -1)) owner = owner?.[key];
  if (!owner || !Object.hasOwn(owner, keys.at(-1))) fail('The local definition disappeared. Refresh Tools.');
  delete owner[keys.at(-1)];
  const next = applyEdits(source, modify(source, keys, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  if (!isDeepStrictEqual(document(next, strict), expected)) fail('Recovery would change unrelated configuration. No changes were made.');
  return next;
}
const normalized = definition => ({ ...definition, ...(Array.isArray(definition?.command) ? { command: definition.command[0], args: definition.command.slice(1) } : {}) });

export async function jsonRecoveryPlan(owner, { agent, projectId, repositoryId, name }, root) {
  if (!['claude', 'opencode'].includes(agent)) fail('Choose a supported MCP agent.');
  // Native approval, intentional disabled state and managed policy are reflected
  // by inventory. Never use a recovery action to bypass those conditions.
  const inventory = await new McpInventory(root, { home: owner.home, env: owner.env }).list();
  const row = inventory.servers.find(row => row.client === agent && row.name === name && !row.plugin);
  if (!row?.enabled || !['invalid-config', 'missing-command'].includes(row.readiness)) fail('No attributable enabled local configuration problem was found.');
  const files = [], guards = [];
  let global, globalFile;
  if (agent === 'claude') {
    const file = owner.env.CLAUDE_CONFIG_DIR ? path.join(owner.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(owner.home, '.claude.json');
    const source = await owner.readRegular(file, path.dirname(file)), value = document(source, true);
    global = value.mcpServers?.[name]; globalFile = file;
    if (global?.url && !['http', 'streamable-http', 'sse'].includes(global.type)) fail('The global Claude transport is not usable.');
    const projects = Object.keys(value.projects || {}).filter(folder => canonical(folder) === canonical(root));
    if (projects.length > 1) fail('Duplicate Claude project locations need manual repair.');
    const projectKey = projects[0];
    if (projectKey && value.projects[projectKey]?.mcpServers?.[name]) files.push({ file, root: path.dirname(file), original: source, next: remove(source, ['projects', projectKey, 'mcpServers', name], true) });
    const projectFile = path.join(root, '.mcp.json');
    try {
      const projectSource = await owner.readRegular(projectFile, root), projectValue = document(projectSource, true);
      if (projectValue.mcpServers?.[name]) files.push({ file: projectFile, root, original: projectSource, next: remove(projectSource, ['mcpServers', name], true) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    guards.push({ file, root: path.dirname(file), original: source });
  } else {
    if (owner.env.OPENCODE_CONFIG || owner.env.OPENCODE_CONFIG_DIR || owner.env.OPENCODE_CONFIG_CONTENT) fail('Custom/runtime OpenCode configuration requires manual recovery.');
    const layers = await openCodeLayers(root, { home: owner.home, env: owner.env });
    const family = layers.some(layer => hasV2Config(layer.value)) ? 2 : 1;
    let globalServers = {};
    for (const layer of layers.filter(layer => layer.scope === 'global')) {
      const configRoot = openCodeConfigDir(owner);
      await owner.readRegular(layer.file, configRoot);
      const servers = openCodeServers(layer.value, family);
      globalServers = family === 2 ? { ...globalServers, ...servers } : mergeOpenCode(globalServers, servers);
      guards.push({ file: layer.file, root: configRoot, original: layer.source });
      if (servers[name]) globalFile = layer.file;
    }
    global = normalized(globalServers[name]);
    if (!['local', 'remote'].includes(global.type)) fail('The global OpenCode transport is not usable.');
    for (const layer of layers.filter(layer => layer.scope === 'project')) {
      await owner.readRegular(layer.file, root);
      const legacy = layer.value.mcp?.[name], native = layer.value.mcp?.servers?.[name];
      if (!legacy && !native) continue;
      if (legacy?.enabled === false || native?.disabled === true) fail('Intentional project Off is not a recovery case.');
      let next = layer.source;
      if (legacy) next = remove(next, ['mcp', name], false);
      if (native) next = remove(next, ['mcp', 'servers', name], false);
      files.push({ file: layer.file, root, original: layer.source, next });
    }
  }
  if (!files.length || !owner.usableGlobal(global)) fail('No usable enabled global definition is available for inheritance.');
  // Removing all same-name project layers is necessary to expose global
  // inheritance. Each affected file is explicitly listed in the review.
  return { files, guards, globalFile, transport: global.url ? 'http' : 'stdio', reason: row.readiness === 'missing-command' ? 'The effective local executable is missing on this PC.' : 'The local transport configuration is invalid.', agent, projectId, repositoryId, name };
}
