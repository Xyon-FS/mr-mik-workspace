import { browserChoice, browserChoices } from './managed-browser.mjs';

const fields = { choice: 'managedBrowser', presentation: 'managedBrowserPresentation', temporary: 'managedBrowserTemporary' };
const allowed = { choice: value => browserChoices.includes(value), presentation: value => ['workspace', 'external'].includes(value), temporary: value => typeof value === 'boolean' };
export function browserConfiguration(settings, session = {}) {
  const result = { choice: browserChoice(settings, session.projectId), presentation: 'workspace', temporary: false };
  for (const [field, key] of Object.entries(fields)) {
    const value = settings[`${key}Projects`]?.[session.projectId] ?? settings[key];
    if (allowed[field](value)) result[field] = value;
    const override = settings.managedBrowserChats?.[session.id]?.[field];
    if (allowed[field](override)) result[field] = override;
  }
  return result;
}

export class BrowserSettings {
  constructor({ settings, save, sessions, browsers, projects, changed = () => {} }) { Object.assign(this, { settings, save, sessions, browsers, projects, changed }); this.chain = Promise.resolve(); }
  read(session, projectId = session?.projectId) {
    const settings = this.settings(), record = session && this.browsers.records.get(session.id);
    const desired = browserConfiguration(settings, session || { projectId });
    return {
      global: { choice: settings.managedBrowser || 'off', presentation: settings.managedBrowserPresentation || 'workspace', temporary: settings.managedBrowserTemporary === true },
      project: Object.fromEntries(Object.entries(fields).map(([field, key]) => [field, settings[`${key}Projects`]?.[projectId] ?? null])),
      chat: settings.managedBrowserChats?.[session?.id] || {}, desired,
      effective: record ? { choice: record.channel, presentation: record.presentation, temporary: record.temporary } : desired,
      pending: !!record?.pendingConfig, status: record?.status || 'idle', owner: record?.owner || 'agent', busy: !!record?.busy,
      note: session?.chatInterface === 'cli' ? 'CLI uses its previous isolated MCP browser; changes apply on next launch. Workspace presentation and persistent profiles are graphical-chat features.' : record?.notice || 'Dedicated website profile per Hub/project/chat/channel. Switching presentation restarts only the browser; tabs and unsaved state may be lost. Return manual control to apply pending changes. CAPTCHA needs manual takeover. Website accounts are separate from agent accounts.',
    };
  }
  change(patch) {
    const task = this.chain.catch(() => {}).then(() => this.apply(patch)); this.chain = task; return task;
  }
  async apply({ scope = 'chat', projectId, sessionId, ...patch }) {
    if (!['global', 'project', 'chat'].includes(scope)) throw new Error('Choose Global, Project or Chat browser scope.');
    const session = sessionId ? this.sessions.items.get(sessionId) : null;
    if (scope === 'chat' && !session) throw new Error('Choose the current chat.');
    if (scope === 'project') { if (!projectId) throw new Error('Choose a project.'); await this.projects.get(projectId); }
    const updates = Object.entries(patch);
    if (!updates.length || updates.some(([field, value]) => !Object.hasOwn(allowed, field) || value !== null && !allowed[field](value) || scope === 'global' && value === null)) throw new Error('Invalid managed browser preference.');
    const settings = this.settings();
    for (const [field, value] of updates) {
      const key = fields[field];
      if (scope === 'global') settings[key] = value;
      else if (scope === 'project') {
        settings[`${key}Projects`] = { ...settings[`${key}Projects`] };
        if (value === null) delete settings[`${key}Projects`][projectId]; else settings[`${key}Projects`][projectId] = value;
      } else {
        settings.managedBrowserChats = { ...settings.managedBrowserChats, [sessionId]: { ...settings.managedBrowserChats?.[sessionId] } };
        if (value === null) delete settings.managedBrowserChats[sessionId][field]; else settings.managedBrowserChats[sessionId][field] = value;
      }
    }
    await this.save(); this.changed();
    for (const record of this.browsers.records.values()) {
      const item = this.sessions.items.get(record.id);
      if (item) await this.browsers.configure(record, browserConfiguration(settings, item));
    }
    return this.read(session, projectId || session?.projectId);
  }
}
