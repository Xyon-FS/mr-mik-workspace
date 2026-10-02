import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { CodexScopes } from './codex-scopes.mjs';
import { ClaudeSettings } from './claude-settings.mjs';
import { OpenCodeSettings } from './opencode-settings.mjs';
import { within } from './util.mjs';
import { parse as parseToml } from 'smol-toml';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// A private projection of declared native components, not a live capability
// claim. Hub skill switches use the Bridge and must not restart native chats.
export async function nativeRefreshSnapshot(session, hubRoot, stateDir, options = {}) {
  const root = await realpath(session.cwd);
  hubRoot = await realpath(hubRoot);
  const projects = { root: async () => root };
  const settings = session.agent === 'codex' ? new CodexScopes(projects, options)
    : session.agent === 'claude' ? new ClaudeSettings(projects, options)
      : new OpenCodeSettings(projects, stateDir, { ...options, family: session.openCodeFamily });
  const inventory = await settings.list('chat', 'primary'), snapshot = {};
  const codexSkills = new Map();
  if (session.agent === 'codex') for (const config of [inventory.globalFile, inventory.file]) {
    const data = parseToml(await readFile(config, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
    for (const entry of data.skills?.config || []) if (typeof entry.path === 'string') {
      const resolved = path.resolve(root, entry.path);
      codexSkills.set((await realpath(resolved).catch(() => resolved)).toLowerCase(), entry.enabled);
    }
  }
  if (session.agent === 'opencode') {
    const state = await settings.state('chat', 'primary');
    const declarations = state.layers.map(layer => [layer.value.plugin || [], layer.value.plugins || []]);
    if (declarations.some(([legacy, native]) => legacy.length || native.length)) snapshot['native:plugin:declarations'] = {
      kind: 'plugin', name: 'Native plugin declarations', enabled: true, plugin: true, definition: hash(declarations),
    };
  }
  for (const row of inventory.rows) {
    if (!['skill', 'plugin'].includes(row.kind)) continue;
    const file = row.kind === 'skill' ? row.path || row.location || row.source : null;
    if (file && ['.agents', '.claude', '.opencode'].some(prefix => within(path.join(hubRoot, prefix, 'skills'), file))) continue;
    let content = null;
    if (file) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Native skill cannot be fingerprinted safely.');
      content = hash(await readFile(file, 'utf8'));
    }
    const nativeSkillState = file && codexSkills.get((await realpath(file)).toLowerCase());
    const enabled = session.agent === 'codex' && row.kind === 'skill' ? nativeSkillState ?? true
      : row.effective ?? (row.state ? row.state !== 'off' : row.projectOverride ?? row.globalEnabled);
    snapshot[`native:${row.kind}:${row.id}`] = {
      kind: row.kind, name: row.name, enabled: !!enabled, plugin: row.kind === 'plugin',
      definition: hash([row.id, row.version ?? null, row.installed ?? null, row.permissionEffect ?? null, file, content]),
    };
  }
  return snapshot;
}
