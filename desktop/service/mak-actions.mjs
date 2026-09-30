import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { within } from './util.mjs';
import { bridgeTools } from './workspace-bridge.mjs';

export class MakActions {
  constructor(services) { Object.assign(this, services); }
  async scope(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['projectId', 'repositoryId', 'cardId', 'selectedId'].includes(key))) throw new Error('Invalid Mak scope.');
    const scope = Object.fromEntries(['projectId', 'repositoryId', 'cardId', 'selectedId'].map(key => [key, input[key] || null]));
    if (Object.values(scope).some(value => value != null && (typeof value !== 'string' || !/^[\w-]{1,128}$/.test(value)))) throw new Error('Invalid Mak target.');
    const project = scope.projectId ? await this.projects.get(scope.projectId) : null;
    if (scope.repositoryId && !project?.repositories.some(item => item.id === scope.repositoryId)) throw new Error('Linked project is outside this workspace.');
    if (scope.cardId) {
      const card = (await this.registry()).entities.find(item => item.id === scope.cardId && (item.projectId || null) === scope.projectId);
      if (!card) throw new Error('Card is outside this workspace.');
      if (Object.hasOwn(input, 'repositoryId') && scope.repositoryId !== (card.repositoryId || null)) throw new Error('The working project must match the selected card. Clear the card selection to choose another project.');
      scope.repositoryId = card.repositoryId || null;
      if (scope.repositoryId && !project?.repositories.some(item => item.id === scope.repositoryId)) throw new Error('Card’s linked project is no longer registered.');
    }
    if (scope.selectedId) this.chat(scope, scope.selectedId);
    return Object.freeze(scope);
  }
  chat(scope, id) {
    const chat = this.sessions.get(id);
    if ((chat.projectId || null) !== scope.projectId) throw new Error('Chat is outside this request workspace. Select its workspace first.');
    return chat;
  }
  async context(scope) {
    const project = scope.projectId ? await this.projects.get(scope.projectId) : null;
    const cards = (await this.registry()).entities.filter(item => (item.projectId || null) === scope.projectId);
    return { workspace: project?.name || 'Global Hub', scope, linkedProjects: project?.repositories.map(({ id, name, available }) => ({ id, name, available })) || [], card: cards.find(item => item.id === scope.cardId)?.title || null, cardCount: cards.length, chats: this.sessions.active().filter(item => (item.projectId || null) === scope.projectId).map(({ id, name, agent, activity }) => ({ id, name, agent, activity })) };
  }
  async bridgeCall(scope, name, args, operationId) {
    const sessionId = `mak-${operationId}`;
    const token = this.bridge.issue(sessionId, scope.projectId, scope.cardId, scope.repositoryId, 'codex');
    try { return await this.bridge.call(token, name, args); }
    finally { this.bridge.revoke(sessionId); }
  }
  async execute(name, args, operationId, scope) {
    // Revalidate the snapshot, never resolve it from the changing UI selection.
    scope = await this.scope(scope);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid Mak arguments.');
    const coordinator = this.coordinator();
    if (coordinator.cancelled.has(operationId)) throw new Error('Request cancelled.');
    const operation = coordinator.operations.get(operationId);
    const observed = id => {
      const chat = this.chat(scope, id), snapshot = coordinator.active?.observedChats.get(id);
      if (!snapshot || snapshot.process !== chat.process || snapshot.lastInputAt !== chat.lastInputAt) throw new Error('Read this chat’s current terminal again before sending or attaching. Its process or user input may have changed.');
      if (chat.activity === 'working') throw new Error('This worker is still working. Inspect it or explicitly interrupt it before sending a new task.');
      return chat;
    };
    if (name === 'hub_catalog') return bridgeTools.map(item => ({ name: item.name, description: item.description.slice(0, 110) }));
    if (name === 'hub_action_schema') { const definition = bridgeTools.find(item => item.name === args.name); if (!definition) throw new Error('Unknown Hub action.'); return definition; }
    if (name === 'hub_action') {
      if (!bridgeTools.some(item => item.name === args.name)) throw new Error('Unknown Hub action.');
      return this.execute(args.name, args.args, operationId, scope);
    }
    const confirm = async label => {
      const safe = Object.fromEntries(['action', 'agent', 'kind', 'scope', 'id', 'name', 'title', 'repositoryId', 'enabled', 'target', 'text', 'paths'].filter(key => key in args).map(key => [key, args[key]]));
      await coordinator.requireConfirmation(label, JSON.stringify(safe), scope);
      if (coordinator.cancelled.has(operationId)) throw new Error('Request cancelled.');
      await this.scope(scope);
    };
    if (name.startsWith('mrmak_')) {
      if (['mrmak_manage_tool', 'mrmak_manage_skill'].includes(name) || name === 'mrmak_context' && args.action === 'save' || ['mrmak_create_resource', 'mrmak_update_resource', 'mrmak_assign_inbox'].includes(name) && args.scope === 'global') {
        await confirm('Apply Mak configuration or global change?');
        if (['mrmak_manage_tool', 'mrmak_manage_skill', 'mrmak_context'].includes(name)) args = { ...args, confirmed: true };
      }
      return this.bridgeCall(scope, name, args, operationId);
    }
    const cards = (await this.registry()).entities.filter(item => (item.projectId || null) === scope.projectId);
    switch (name) {
      case 'list_projects': return (await this.projects.list()).map(({ id, name, repositories }) => ({ id, name, linkedProjects: repositories.map(({ id, name, available }) => ({ id, name, available })) }));
      case 'list_chats': return this.sessions.active().filter(item => (item.projectId || null) === scope.projectId);
      case 'search_history': return this.history(args.query || '').filter(item => (item.projectId || null) === scope.projectId).slice(0, 50);
      case 'open_chat': {
        if (args.projectId != null && args.projectId !== scope.projectId || args.cwd != null || args.bypass != null) throw new Error('Use this workspace’s linked-project IDs and the configured permissions, not arbitrary folders or bypass overrides.');
        const target = await this.scope({ ...scope, repositoryId: Object.hasOwn(args, 'repositoryId') ? args.repositoryId : scope.repositoryId, cardId: Object.hasOwn(args, 'cardId') ? args.cardId : scope.cardId });
        await confirm('Open a new worker chat?');
        const session = await this.createChat({ agent: args.agent, name: args.name, effort: args.effort, projectId: target.projectId, repositoryId: target.repositoryId || 'hub', cardId: target.cardId, cwd: this.repo }, operation?.text || '');
        this.focus(session.id); return session;
      }
      case 'read_chat': { const chat = this.chat(scope, args.id), screen = await this.sessions.read(args.id); coordinator.active?.observedChats.set(args.id, { process: chat.process, lastInputAt: chat.lastInputAt }); return screen; }
      case 'focus_chat': this.chat(scope, args.id); return this.focus(args.id);
      case 'send_to_chat': observed(args.id); await confirm('Send this task to the worker chat?'); observed(args.id); return this.sessions.input(args.id, args.text, { coordinator: true, submit: true });
      case 'attach_files': observed(args.id); await confirm('Attach paths to the worker chat?'); observed(args.id); return this.attach(args.id, args.paths, true);
      case 'reopen_chat': this.chat(scope, args.id); await confirm('Resume this worker chat?'); { const chat = await this.sessions.resume(args.id); this.focus(chat.id); return chat; }
      case 'close_chat': this.chat(scope, args.id); await confirm('Close this worker chat?'); return this.closeChat(args.id);
      case 'interrupt_chat': this.chat(scope, args.id); await confirm('Interrupt this worker chat?'); this.sessions.input(args.id, '\x03'); return { delivered: 'Ctrl+C' };
      case 'pin_chat': this.chat(scope, args.id); return this.sessions.pin(args.id, args.pinned);
      case 'rename_chat': this.chat(scope, args.id); return this.sessions.rename(args.id, args.name);
      case 'list_workspace': return (await this.workspace.list(args)).filter(item => cards.some(card => card.id === item.id));
      case 'read_workspace': if (!cards.some(card => card.id === args.entityId)) throw new Error('Card is outside this workspace.'); return this.workspace.read(args.entityId, args.step);
      case 'update_workspace': if (!cards.some(card => card.id === args.entityId)) throw new Error('Card is outside this workspace.'); return this.workspace.update(args.entityId, args);
      case 'workspace_activity': { const activity = await this.workspace.activity(args.date); return { ...activity, commits: [], cards: activity.cards.filter(item => cards.some(card => card.id === item.id)) }; }
      case 'show_workspace': case 'navigate_app': {
        const cardId = args.cardId || args.entityId || null;
        if (cardId && !cards.some(card => card.id === cardId)) throw new Error('Card is outside this workspace.');
        return this.navigate({ projectId: scope.projectId, cardId, section: args.section, step: args.step });
      }
      case 'preview_file': case 'list_files': {
        const file = await realpath(path.resolve(args.path || this.repo));
        const project = scope.projectId ? await this.projects.get(scope.projectId) : null;
        const allowed = within(this.repo, file) || (project?.repositories || []).some(item => item.available && within(item.repositoryPath, file));
        if (!allowed) throw new Error('File is outside this request workspace.');
        if (name === 'list_files') return this.files.list(file, 'all', args.query || '');
        const preview = await this.files.preview(file); this.show('workspace', { preview }); return { shown: preview.path };
      }
      case 'search_context': return { context: await this.library.search(args.query, ['context']), knowledge: await this.projects.searchResources('knowledge', scope.projectId, args.query), processes: await this.projects.searchResources('process', scope.projectId, args.query) };
      case 'read_context': return this.library.read(args.path, args.offset);
      case 'list_skills': return this.bridgeCall(scope, 'mrmak_list_hub_skills', {}, operationId);
      case 'list_mcp': return this.bridgeCall(scope, 'mrmak_tool_settings', {}, operationId);
      case 'get_app_settings': return { voice: 'disabled', model: coordinator.model || 'Codex default', effort: this.settings().coordinatorEffort, scope };
      default: throw new Error('Unknown Mak operation.');
    }
  }
}
