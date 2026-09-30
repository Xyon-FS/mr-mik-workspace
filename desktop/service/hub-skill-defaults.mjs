export const coreHubSkills = Object.freeze(['workspace-authoring', 'feature-handoff']);
const defaults = () => Object.fromEntries(coreHubSkills.map(id => [id, { global: true, projects: {} }]));
// This public seed is supplied only with new source/portable Hubs. Existing
// Hubs without the seed keep their previous Off defaults and scope choices.
export const defaultHubSkillScopes = { skills: defaults(), claudeSkills: defaults() };
export const hubSkillUseRule = 'Before requested Hub card content, discover enabled skills and consult workspace-authoring via mrmak_card_authoring_guide. Before a handoff, consult enabled feature-handoff via mrmak_read_hub_skill. Skip disabled skills; empty-card creation and metadata-only changes need no authoring read. Read only when relevant, reuse instructions while they remain in context, and do not preload other skills.';
