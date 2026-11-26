import { defaultHubSkillScopes } from './hub-skill-defaults.mjs';
const groups = { skills: 'codex', claudeSkills: 'claude', opencodeSkills: 'opencode' };
export const skillFiles = ['projects/skill-scopes.json', 'projects/skill-defaults.json'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safe = value => /^[a-z0-9][a-z0-9-]{0,99}$/i.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

export function validateSkillScopes(value) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(groups, key))) throw new Error('Invalid transferable skill scope registry.');
  for (const settings of Object.values(value)) {
    if (!object(settings)) throw new Error('Invalid transferable skill settings.');
    for (const [id, setting] of Object.entries(settings)) {
      if (!safe(id) || !object(setting) || Object.keys(setting).some(key => !['global', 'projects'].includes(key)) || setting.global != null && typeof setting.global !== 'boolean' || setting.projects != null && !object(setting.projects)) throw new Error('Invalid transferable skill setting.');
      for (const [project, enabled] of Object.entries(setting.projects || {})) if (!safe(project) || typeof enabled !== 'boolean') throw new Error('Invalid transferable skill project override.');
    }
  }
  return value;
}

// Mirror Projects.hubSkillScopes: a stored skill entry replaces its default
// entry; per-project overrides then take precedence over that skill's global.
export function effectiveSkillScopes(defaults = {}, stored = {}) {
  validateSkillScopes(defaults); validateSkillScopes(stored);
  if (defaults.skills?.['workspace-authoring']?.global === true && !defaults.opencodeSkills) defaults = { ...defaults, opencodeSkills: structuredClone(defaultHubSkillScopes.opencodeSkills) };
  return Object.fromEntries(Object.keys(groups).filter(key => defaults[key] || stored[key]).map(key => [key, { ...defaults[key], ...stored[key] }]));
}

export function mergeSkillScopes(local, incoming, replace = []) {
  validateSkillScopes(local); validateSkillScopes(incoming);
  if (!Array.isArray(replace) || replace.some(id => typeof id !== 'string') || new Set(replace).size !== replace.length) throw new Error('Invalid skill conflict choices.');
  const output = structuredClone(local), conflicts = [];
  const choose = (group, skill, scope, projectId, before, after) => {
    if (before === undefined) return after;
    if (before === after) return before;
    const id = JSON.stringify([group, skill, scope, projectId]);
    conflicts.push({ id, agent: groups[group], skill, scope, projectId, local: before, incoming: after });
    return replace.includes(id) ? after : before;
  };
  for (const [group, settings] of Object.entries(incoming)) {
    output[group] ||= {};
    for (const [skill, setting] of Object.entries(settings)) {
      const existing = output[group][skill];
      if (!existing) { output[group][skill] = structuredClone(setting); continue; }
      const merged = structuredClone(existing);
      // An entry lacking global means Off in the application, not inheritance.
      merged.global = choose(group, skill, 'global', null, existing.global === true, setting.global === true);
      if (setting.projects) {
        merged.projects ||= {};
        for (const [project, enabled] of Object.entries(setting.projects)) merged.projects[project] = choose(group, skill, 'project', project, merged.projects[project], enabled);
      }
      output[group][skill] = merged;
    }
  }
  if (replace.some(id => !conflicts.some(conflict => conflict.id === id))) throw new Error('Skill conflict choices changed. Review import again.');
  return { scopes: output, conflicts };
}
