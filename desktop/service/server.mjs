import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { readFile, stat, realpath, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseEnv } from 'dotenv';
import { parse as parseToml } from 'smol-toml';
import { Sessions } from './sessions.mjs';
import { codexPermissionMode } from './codex-permissions.mjs';
import { CodexModelPicker } from './model-picker.mjs';
import { ClaudeModelPicker, ClaudeEffortPicker } from './claude-model-picker.mjs';
import { OpenCodePicker } from './opencode-picker.mjs';
import { Accounts } from './accounts.mjs';
import { Coordinator } from './coordinator.mjs';
import { MakActions } from './mak-actions.mjs';
import { workerControls } from './worker-controls.mjs';
import { ToolRefresh, mcpSnapshot, emptyNativePrompt } from './tool-refresh.mjs';
import { nativeRefreshSnapshot } from './native-refresh-snapshot.mjs';
import { codexTranscript, claudeTranscript } from './native-events.mjs';
import { Files, serveFile } from './files.mjs';
import { importFile, dragFiles, moveFile, recyclePath, MAX_FILE_BYTES } from './file-transfers.mjs';
import { inventory } from './agents.mjs';
import { Attachments, attachmentText, MAX_IMAGE_BYTES } from './attachments.mjs';
import { ContextLibrary } from './context.mjs';
import { englishTitle, taskTitle } from './titles.mjs';
import { defaultWorkerEffort, defaultWorkerEfforts, claudeEfforts, workerDefault, taskEffort } from './effort.mjs';
import { Workspace, localDay } from './workspace.mjs';
import { QuickActions } from './quick-actions.mjs';
import { defaultVoiceStyle } from './voice-profile.mjs';
import { NativeSettings } from './native-settings.mjs';
import { McpInventory } from './mcp.mjs';
import { Projects } from './projects.mjs';
import { CardRecycler } from './card-removal.mjs';
import { addExampleWorkspace } from './example-workspace.mjs';
import { PortableArchive } from './portable-archive.mjs';
import { WorkspaceSnapshot } from './workspace-snapshot.mjs';
import { NativeDeletion } from './native-delete.mjs';
import { WorkspaceBridge } from './workspace-bridge.mjs';
import { hubContentDirectories } from './hub-files.mjs';
import { chatOrientation, codexSessionInstructions, codexAllowsAdditionalDirectories } from './chat-orientation.mjs';
import { CodexScopes } from './codex-scopes.mjs';
import { effectiveCodex } from './codex-effective.mjs';
import { CodexMcpEditor } from './codex-mcp-editor.mjs';
import { ClaudeMcpEditor } from './claude-mcp-editor.mjs';
import { ClaudeSettings } from './claude-settings.mjs';
import { OpenCodeSettings } from './opencode-settings.mjs';
import { installedIde, openIde } from './ide.mjs';
import { body, equalSecret, json, publicError, readJson, realFile, saveJson, secret, within } from './util.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });

export async function createService({ repo, uiDir, stateDir, token = secret(), native = () => {}, restoreSessions = false, mcpOptions }) {
  repo = await realpath(repo);
  stateDir ||= path.join(repo, '.mrmak');
  const files = new Files(repo);
  const attachments = new Attachments(repo);
  const library = new ContextLibrary(repo);
  const mcp = new McpInventory(repo, mcpOptions);
  const sessions = await new Sessions(repo, stateDir).init();
  const modelPicker = new CodexModelPicker(sessions);
  const openCodePicker = new OpenCodePicker(sessions);
  const accounts = new Accounts({ blocked: agent => sessions.list().some(item => item.agent === agent && (item.open || item.status === 'running')) || agent === 'codex' && coordinator.operationPromises.size > 0 });
  const workers = workerControls(sessions, openCodePicker);
  const claudeModelPicker = new ClaudeModelPicker(sessions);
  const claudeEffortPicker = new ClaudeEffortPicker(sessions);
  const environment = parseEnv(await readFile(path.join(repo, '.env'), 'utf8').catch(() => ''));
  const settingsPath = path.join(stateDir, 'settings.json');
  let settings = { defaultAgent: 'codex', defaultBypass: false, defaultWorkerEffort, coordinatorModel: environment.MRMAK_COORDINATOR_MODEL?.trim() || null, terminalFontSize: 13, terminalAppearance: 'focus', accentTheme: 'rose', coordinatorEffort: 'medium', voiceName: 'cedar', voiceStyle: defaultVoiceStyle, ...await readJson(settingsPath, {}) };
  settings.defaultCodexPermissions = codexPermissionMode(settings.defaultCodexPermissions, settings.defaultBypass);
  if (!defaultWorkerEfforts.includes(settings.defaultWorkerEffort)) settings.defaultWorkerEffort = defaultWorkerEffort;
  if (!claudeEfforts.includes(settings.defaultClaudeWorkerEffort)) settings.defaultClaudeWorkerEffort = claudeEfforts.includes(settings.defaultWorkerEffort) ? settings.defaultWorkerEffort : 'high';
  if (!defaultWorkerEfforts.includes(settings.coordinatorEffort)) settings.coordinatorEffort = 'medium';
  if (!['rose', 'violet', 'blue', 'teal'].includes(settings.accentTheme)) settings.accentTheme = 'rose';
  let selectedId = sessions.active().some(item => item.id === settings.selectedId) ? settings.selectedId : sessions.active()[0]?.id || null;
  let workspaceRoute = settings.workspaceRoute || null;
  let settingsTimer;
  let settingsSave = Promise.resolve();
  const saveSettings = () => { settingsSave = settingsSave.catch(() => {}).then(() => saveJson(settingsPath, settings)); return settingsSave; };
  const scheduleSettings = () => { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveSettings().catch(() => {}), 500); };
  const transcriptPath = path.join(stateDir, 'voice-transcripts.json');
  let voiceHistory = await readJson(transcriptPath, []);
  let transcriptSave = Promise.resolve();
  let voiceOwner = null;
  let closing = false;
  const clients = new Set();
  const notices = [];
  const send = (ws, type, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...value })); };
  const broadcast = (type, value) => { for (const ws of clients) send(ws, type, value); };
  const nativeSettings = new NativeSettings(native, value => broadcast('native-settings', value));
  const show = (window, extra = {}) => { native({ type: 'window', action: 'show', window }); broadcast('navigate', { window, ...extra }); };
  const focus = id => { sessions.get(id); selectedId = id; settings.selectedId = id; scheduleSettings(); show('chats', { sessionId: id }); return { selectedId: id }; };
  const registry = async () => readJson(path.join(repo, 'workspace', 'workspace.json'), { entities: [] });
  const workspace = new Workspace(repo, () => broadcast('workspace-changed', {}));
  const projects = new Projects(repo, stateDir, () => { broadcast('projects-changed', {}); broadcast('workspace-changed', {}); });
  const cardRecycler = new CardRecycler(native);
  projects.recycleCardFolder = file => cardRecycler.recycle(file);
  const portable = new PortableArchive(repo, stateDir, sessions, projects);
  const snapshots = new WorkspaceSnapshot(repo, stateDir, projects);
  const nativeDeletion = new NativeDeletion(sessions, stateDir);
  const codexScopes = new CodexScopes(projects, mcpOptions);
  const codexMcpEditor = new CodexMcpEditor(projects, mcpOptions);
  const claudeMcpEditor = new ClaudeMcpEditor(projects, stateDir, mcpOptions);
  const claudeSettings = new ClaudeSettings(projects, mcpOptions);
  const openCodeSettings = new OpenCodeSettings(projects, stateDir, mcpOptions);
  openCodeSettings.inspectSkills = async root => {
    const chat = [...sessions.items.values()].find(item => item.agent === 'opencode' && item.openCodeFamily === 2 && item.open && item.process && path.resolve(item.cwd).toLowerCase() === path.resolve(root).toLowerCase());
    if (!chat || openCodePicker.busy.has(chat.id) || openCodePicker.openMenus.has(chat.id) || openCodePicker.requests?.has(chat.id)) return null;
    try { return (await openCodePicker.command(chat.id, 'skills')).skills; } catch { return null; }
  };
  openCodeSettings.inspectPlugins = async root => {
    const chat = [...sessions.items.values()].find(item => item.agent === 'opencode' && item.openCodeFamily === 2 && item.open && item.process && path.resolve(item.cwd).toLowerCase() === path.resolve(root).toLowerCase());
    if (!chat || openCodePicker.busy.has(chat.id) || openCodePicker.openMenus.has(chat.id) || openCodePicker.requests?.has(chat.id)) return;
    try { const result = await openCodePicker.command(chat.id, 'plugins'); openCodeSettings.observePlugins(root, result.plugins); } catch { /* Unknown contracts leave declarations read-only; never guess IDs. */ }
  };
  const toolRefresh = new ToolRefresh(sessions, {
    snapshot: async session => ({
      ...mcpSnapshot(await new McpInventory(session.cwd, mcpOptions).scan(), session.agent),
      ...await nativeRefreshSnapshot(session, repo, stateDir, mcpOptions),
    }),
    ready: async session => {
      if ([modelPicker, claudeModelPicker, claudeEffortPicker, openCodePicker].some(picker => picker.busy.has(session.id) || picker.openMenus.has(session.id)) || openCodePicker.requests?.has(session.id)) return false;
      if (Date.now() - Date.parse(session.lastInputAt || 0) < 1500) return false;
      if (session.agent === 'opencode') { try { const ready = await openCodePicker.command(session.id, 'mcp-ready'); session.liveMcpAvailable = ready.mcpRefreshAvailable === true; return true; } catch { return false; } }
      await new Promise(resolve => session.terminal.write('', resolve));
      return emptyNativePrompt(session);
    },
    live: (session, changes) => openCodePicker.command(session.id, 'mcp-refresh', { changes }),
    restart: (session, guard) => sessions.restartTools(session, guard),
  });
  sessions.captureTools = session => toolRefresh.capture(session);
  sessions.permissionReady = session => toolRefresh.ready(session);
  sessions.toolsLaunched = (session, baseline) => toolRefresh.launched(session, baseline);
  toolRefresh.wrap(codexScopes, 'set', (_projectId, change) => ['mcp', 'plugin', 'skill'].includes(change.kind));
  toolRefresh.wrap(codexMcpEditor, 'change', () => true);
  toolRefresh.wrap(claudeMcpEditor, 'change', () => true);
  toolRefresh.wrap(claudeSettings, 'set', (_projectId, change) => ['plugin', 'skill'].includes(change.kind));
  toolRefresh.wrap(openCodeSettings, 'change', change => ['mcp', 'skill', 'plugin'].includes(change.kind || 'mcp'));
  toolRefresh.wrap(projects, 'createSkill', change => change.target === 'linked');
  toolRefresh.wrap(files, 'saveMarkdown', () => true);
  const projectMcps = new Map();
  const projectMcp = async (id, repositoryId) => {
    if (!id) return mcp;
    if (!(await projects.get(id)).repositories.length) return mcp;
    const root = await projects.root(id, repositoryId);
    const key = `${id}:${repositoryId || 'primary'}`;
    const previous = projectMcps.get(key);
    if (previous?.repo === root) return previous;
    previous?.close(); const next = new McpInventory(root, mcpOptions); projectMcps.set(key, next); return next;
  };
  const bridge = new WorkspaceBridge(projects, workspace, registry, { codexScopes, codexMcpEditor, claudeMcpEditor, claudeSettings, openCodeSettings, mcpInventory: async (id, repositoryId) => (await projectMcp(id, repositoryId)).list() });
  const legacyProjectChatFolder = id => path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'MrMak', 'project-chats', id);
  const projectChatFolder = id => path.join(repo, 'workspace', 'planning', id);
  let cardMutation = false;
  const changeCards = async action => {
    if (cardMutation || coordinator.operationPromises.size) throw Object.assign(new Error('Wait for the current change or stop Mik before removing cards or registrations.'), { status: 409 });
    cardMutation = true;
    try { return await action(); } finally { cardMutation = false; }
  };
  const detachChats = async (matches, patch) => {
    for (const session of sessions.items.values()) if (matches(session)) { bridge.revoke(session.id); Object.assign(session, patch); sessions.changed(session); }
    await sessions.persist();
  };
  const sessionOptions = async options => {
    if ((options.agent || "codex") === "codex") options = { ...options, codexPermissions: codexPermissionMode(options.codexPermissions ?? settings.defaultCodexPermissions, options.bypass ?? settings.defaultBypass) };
    if (cardMutation) throw new Error('Wait for the card or workspace change before opening a chat.');
    if (!options.projectId) {
      const card = options.cardId ? (await registry()).entities.find(item => item.id === options.cardId && !item.projectId) : null;
      if (options.cardId && !card) throw new Error('Card is not associated with the global Hub.');
      return { ...options, repositoryId: null, cardId: card?.id || null, ...(card ? { cwd: repo } : {}) };
    }
    const project = await projects.get(options.projectId);
    const card = options.cardId ? (await registry()).entities.find(item => item.id === options.cardId && item.projectId === project.id) : null;
    if (options.cardId && !card) throw new Error('Card is not associated with this project.');
    const preferred = project.repositories.find(item => item.id === card?.repositoryId);
    const repositoryId = options.repositoryId === 'hub' ? null : options.repositoryId || (card?.repositoryId ? preferred?.available ? preferred.id : null : project.repositories.find(item => item.available)?.id || null);
    if (repositoryId && !project.repositories.some(item => item.id === repositoryId)) throw new Error('Repository is not associated with this project.');
    const cwd = repositoryId ? await projects.root(project.id, repositoryId) : projectChatFolder(project.id);
    if (!repositoryId) await mkdir(cwd, { recursive: true });
    return { ...options, repositoryId, cardId: card?.id || null, cwd };
  };
  sessions.prepareLaunch = async (session, { preview = false } = {}) => {
    if (cardMutation) throw new Error('Wait for the card or workspace change before opening or resuming a chat.');
    const launch = async (project, card, linked) => {
      const folderName = linked?.repositoryPath && path.basename(linked.repositoryPath);
      const workingProjectName = linked ? !folderName || linked.name.toLowerCase() === folderName.toLowerCase() ? linked.name : `${linked.name} (${folderName})` : null;
      const orientation = chatOrientation({ workspaceName: project?.name, cardName: card?.title, workingProjectName });
      const instructions = session.agent === 'codex' ? await codexSessionInstructions(orientation, codexScopes.codexHome(), session.cwd) : null;
      // Hub skills are consulted through the scoped Bridge. When Claude starts
      // under this Hub, suppress native discovery so Hub Off cannot be bypassed.
      const settings = session.agent === 'claude' && !linked ? { skillOverrides: Object.fromEntries((await projects.hubSkills(project?.id || null, 'claude')).map(skill => [skill.name, 'off'])) } : null;
      const hubSkills = session.agent === 'opencode' && !linked ? await projects.hubSkills(project?.id || null, 'opencode') : [];
      const contentDirectories = await hubContentDirectories(projects, (await registry()).entities, project?.id || null);
      const codexWritableRoots = session.agent === 'codex' && await codexAllowsAdditionalDirectories(codexScopes.codexHome(), session.cwd);
      return { script: fileURLToPath(new URL('./bridge-mcp.mjs', import.meta.url)), url: `${origin}/bridge`, token: preview ? '' : bridge.issue(session.id, project?.id || null, card?.id || null, linked?.id || null, session.agent), orientation, instructions, settings, contentDirectories, codexWritableRoots, hubSkillNames: hubSkills.map(skill => skill.name), hubSkillIds: hubSkills.map(skill => skill.id) };
    };
    if (!session.projectId) {
      if (!['codex', 'claude', 'opencode'].includes(session.agent)) return null;
      if ((await realpath(session.cwd)).toLowerCase() !== repo.toLowerCase()) return null;
      const card = session.cardId ? (await registry()).entities.find(item => item.id === session.cardId && !item.projectId) : null;
      return launch(null, card, null);
    }
    const root = session.repositoryId === null ? projectChatFolder(session.projectId) : await projects.root(session.projectId, session.repositoryId);
    if (session.repositoryId === null) await mkdir(root, { recursive: true });
    const actual = (await realpath(session.cwd)).toLowerCase();
    const legacy = session.repositoryId === null ? await realpath(legacyProjectChatFolder(session.projectId)).catch(() => null) : null;
    if (root.toLowerCase() !== actual && legacy?.toLowerCase() !== actual) throw new Error('Project location changed. Open a new chat; the existing conversation keeps its original folder.');
    if (!['codex', 'claude', 'opencode'].includes(session.agent)) return null;
    const project = await projects.get(session.projectId);
    const card = session.cardId ? (await registry()).entities.find(item => item.id === session.cardId && item.projectId === project.id) : null;
    const linked = project.repositories.find(item => item.id === session.repositoryId);
    return launch(project, card, linked);
  };
  sessions.revokeBridge = id => bridge.revoke(id);
  const history = query => sessions.list().filter(item => (!item.open || item.hasConversation || item.pinned || (item.agent === 'shell' && item.lastInputAt)) && (!query || `${item.name} ${item.agent} ${item.cwd} ${item.preview || ''}`.toLowerCase().includes(query.toLowerCase()))).sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const closeChat = async id => {
    const session = await sessions.remove(id);
    // Opening a terminal is not a conversation. Keep native CLI data untouched,
    // but discard an unused Mr. Mik tab instead of adding it to History.
    const savedInHistory = !!(session.hasConversation || session.pinned || (session.agent === 'shell' && session.lastInputAt));
    if (!savedInHistory) await sessions.forget(id);
    if (selectedId === id) { selectedId = sessions.active()[0]?.id || null; settings.selectedId = selectedId; scheduleSettings(); broadcast('selection', { selectedId }); }
    return { closed: true, savedInHistory };
  };
  const attach = async (id, paths, coordinator = false) => {
    const session = sessions.get(id);
    const verified = await attachments.paths(paths);
    sessions.input(id, attachmentText(verified, session.agent), { coordinator, submit: false });
    return { attached: verified, submitted: false };
  };
  const coordinator = await new Coordinator({
    threadConfig: async () => {
      const global = await codexScopes.list(null);
      let hub;
      try { hub = parseToml(await readFile(path.join(repo, '.codex', 'config.toml'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })); }
      catch { throw new Error('Hub Codex configuration is malformed or unreadable; Mak was not started.'); }
      const components = [...global.rows.filter(item => ['mcp', 'plugin'].includes(item.kind)), ...Object.keys(hub.mcp_servers || {}).map(id => ({ kind: 'mcp', id })), ...Object.keys(hub.plugins || {}).map(id => ({ kind: 'plugin', id }))];
      return { 'features.apps': false, web_search: 'disabled', mcp_servers: Object.fromEntries(components.filter(item => item.kind === 'mcp').map(item => [item.id, { enabled: false }])), plugins: Object.fromEntries(components.filter(item => item.kind === 'plugin').map(item => [item.id, { enabled: false }])) };
    },
    repo, stateDir, orientation: async () => 'Mr. Mik has a Global Hub and logical workspaces. Each workspace contains linked projects and cards. Cards, Knowledge, Processes and Inbox belong to the Hub, never the linked folders. Context is global; technical project rules stay in linked AGENTS.md. Use hub_catalog and hub_action_schema to discover Hub operations, then hub_action to invoke the scoped Bridge. Use visible Codex/Claude/OpenCode worker chats for actual project execution. OpenCode keeps its own provider access and native model variants; omit worker effort for it. Discover relevant skills and procedures, then read only what is needed. A request scope is immutable: UI navigation must not change its targets. Global/configuration changes and worker messages require a real UI confirmation, not a model-generated confirmed flag. Do not retry rejected actions. Configuration is not proof of a live MCP connection. Voice is disabled. Never install tools, approve agent permissions or delete native conversations through the coordinator.', settings: () => settings,
    context: scope => scope ? makActions.context(scope) : ({ repo, activeProjectId: settings.selectedProjectId || null, localDate: localDay(), selectedId, workspaceRoute, chats: sessions.active(), recentNotices: notices.slice(-5), recentRequests: [...coordinator.operations.values(), ...quick.operations.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-6).map(({ text, result, status }) => ({ text, result, status })) }),
    execute: async (name, args, operationId, requestText, scope) => {
      if (scope) return makActions.execute(name, args, operationId, scope);
      const latestRequest = requestText || coordinator.operations.get(operationId)?.text || '';
      switch (name) {
        case 'list_chats': return sessions.active();
        case 'search_history': return history(args.query || '').slice(0, 70);
        case 'reopen_chat': { const session = await sessions.resume(args.id); focus(session.id); return session; }
        case 'close_chat': return closeChat(args.id);
        case 'pin_chat': return sessions.pin(args.id, args.pinned);
        case 'list_projects': return projects.list();
        case 'open_chat': { if (args.agent === 'opencode' && args.effort != null) throw new Error('OpenCode uses native model variants. Omit effort.'); const session = await sessions.create(await sessionOptions({ ...args, name: taskTitle(args.name), effort: args.effort ? taskEffort(latestRequest, args.effort) : workerDefault(settings, args.agent), bypass: args.bypass ?? settings.defaultBypass })); focus(session.id); return session; }
        case 'read_chat': return sessions.read(args.id);
        case 'send_to_chat': return workers.send(args.id, args.text);
        case 'attach_files': return attach(args.id, args.paths, true);
        case 'focus_chat': return focus(args.id);
        case 'rename_chat': return sessions.rename(args.id, args.name);
        case 'interrupt_chat': return workers.interrupt(args.id);
        case 'list_workspace': return workspace.list(args);
        case 'read_workspace': return workspace.read(args.entityId, args.step);
        case 'workspace_activity': return workspace.activity(args.date);
        case 'update_workspace': return workspace.update(args.entityId, args);
        case 'show_workspace': {
          if (args.entityId && !(await registry()).entities.some(item => item.id === args.entityId)) throw new Error('Workspace report does not exist');
          workspaceRoute = args.entityId ? `#/${encodeURIComponent(args.entityId)}${Number.isInteger(args.step) ? '/' + args.step : ''}` : null;
          settings.workspaceRoute = workspaceRoute; scheduleSettings();
          show('workspace', { route: workspaceRoute }); return { shown: true, route: workspaceRoute };
        }
        case 'preview_file': { const preview = await files.preview(args.path); show('workspace', { preview }); return { shown: preview.path }; }
        case 'list_files': return files.list(args.path || repo, 'all', args.query || '');
        case 'search_context': {
          const projectId = settings.selectedProjectId || '';
          return { context: await library.search(args.query, ['context']), knowledge: await projects.searchResources('knowledge', projectId, args.query), processes: await projects.searchResources('process', projectId, args.query) };
        }
        case 'read_context': return library.read(args.path, args.offset);
        case 'list_skills': return library.skills(args.query || '');
        case 'list_mcp': return mcp.list();
        case 'get_app_settings': return { voice: 'disabled', model: coordinator.model || 'Codex default', effort: settings.coordinatorEffort, billing: 'Codex subscription for the coordinator' };
        default: throw new Error('Unknown coordinator tool');
      }
    },
  }).init();
  const makActions = new MakActions({ repo, projects, sessions, workspace, registry, bridge, files, library, history, attach, closeChat, focus, show, workerControls: workers, workerAgents: () => inventory().filter(item => item.id !== 'shell').map(({ id, available }) => ({ id, available })), coordinator: () => coordinator, settings: () => settings,
    createChat: async (options, request) => sessions.create(await sessionOptions({ ...options, name: taskTitle(options.name), effort: options.effort ? taskEffort(request, options.effort) : workerDefault(settings, options.agent), bypass: settings.defaultBypass })),
    navigate: async ({ projectId, cardId, section, step }) => {
      settings.selectedProjectId = projectId;
      workspaceRoute = cardId ? `#/${encodeURIComponent(cardId)}${Number.isInteger(step) ? '/' + step : ''}` : '';
      settings.workspaceRoute = workspaceRoute; await saveSettings(); broadcast('settings', { settings });
      show('workspace', { route: workspaceRoute, section }); return { shown: true, projectId, cardId, section };
    },
  });
  const quick = await new QuickActions({ stateDir, workspace, context: () => ({ chats: sessions.active(), route: workspaceRoute }), execute: (...args) => coordinator.execute(...args), completed: operation => broadcast('coordinator-result', { operation }) }).init();
  const askMak = async data => {
    if (cardMutation) throw new Error('Wait for the card or workspace change before asking Mik.');
    if (Object.hasOwn(data, 'scope')) {
      if (typeof data.id !== 'string' || !/^[\w-]{1,128}$/.test(data.id)) throw new Error('Invalid Mak request ID.');
      const scope = await makActions.scope(data.scope);
      const existing = coordinator.operations.get(data.id);
      if (existing?.scope && JSON.stringify(existing.scope) !== JSON.stringify(scope)) throw new Error('Request ID belongs to another scope.');
      return coordinator.ask({ id: data.id, text: data.text, scope, conversationId: data.conversationId });
    }
    if (coordinator.operationPromises.has(data.id) || coordinator.operations.has(data.id)) return coordinator.ask(data);
    return await quick.ask(data) || coordinator.ask(data);
  };
  coordinator.on('state', state => broadcast('coordinator-state', { state }));
  coordinator.on('result', operation => broadcast('coordinator-result', { operation }));
  coordinator.on('confirmation', confirmation => broadcast('coordinator-confirmation', { confirmation }));
  coordinator.on('error-detail', error => broadcast('service-error', { error }));
  sessions.on('session', session => broadcast('session', { session }));
  sessions.on('removed', ({ id }) => broadcast('removed', { id }));
  sessions.on('screen-cleared', ({ id }) => broadcast('screen-cleared', { id }));
  sessions.on('service-error', error => broadcast('service-error', { error: publicError(error) }));
  sessions.on('output', output => {
    for (const ws of clients) {
      if (ws.sessionId !== output.id) continue;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Reconnect to restore the terminal screen'); continue; }
      send(ws, 'output', output);
    }
  });
  sessions.on('notice', notice => { notices.push(notice); if (notices.length > 100) notices.shift(); broadcast('notice', { notice }); });

  const contentServer = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(files.origin).host || !['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Not allowed'), { status: 403 });
      await files.content(request, response, new URL(request.url, files.origin));
    } catch (error) { if (!response.headersSent) json(response, error.status || 404, { error: publicError(error) }); }
  });
  files.origin = await listen(contentServer);

  function authorize(request) {
    if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error('Unexpected host'), { status: 403 });
    if (request.headers.origin && request.headers.origin !== origin) throw Object.assign(new Error('Unexpected origin'), { status: 403 });
    if (!equalSecret(request.headers.authorization, `Bearer ${token}`)) throw Object.assign(new Error('Open Mr. Mik from its desktop launcher'), { status: 401 });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error('Unexpected host'), { status: 403 });
      if (url.pathname === '/bridge') {
        if (request.method !== 'POST' || request.headers.origin) throw Object.assign(new Error('Not allowed'), { status: 403 });
        const data = await body(request, 3 * 1024 * 1024);
        return json(response, 200, await bridge.call(String(request.headers.authorization || '').replace(/^Bearer /, ''), data.name, data.args));
      }
      if (url.pathname === '/health') return json(response, 200, { service: 'mrmik', version: '0.2.9' });
      if (url.pathname.startsWith('/api/')) {
        authorize(request);
        const method = request.method;
        // Keep legacy transcripts, but never create a new paid voice session.
        if (method === 'POST' && url.pathname === '/api/live/session') return json(response, 410, { error: 'Voice is temporarily unavailable in Mr. Mik.' });
        if (method === 'POST' && url.pathname === '/api/files/import') {
          if (Number(request.headers['content-length']) > MAX_FILE_BYTES) throw Object.assign(new Error('Choose files of 1 GB or less.'), { status: 413 });
          const result = await importFile(request, url.searchParams.get('folder'), url.searchParams.get('name'));
          broadcast('workspace-changed', {});
          return json(response, 201, result);
        }
        if (method === 'POST' && url.pathname === '/api/attachments') {
          const sessionId = request.headers['x-session-id'];
          // The chat's explicit project wins. An unassigned chat follows the
          // workspace currently selected by the user when the image is pasted.
          const projectId = (sessionId ? sessions.get(sessionId).projectId : null) || settings.selectedProjectId || null;
          if (projectId) await projects.get(projectId);
          const chunks = []; let length = 0;
          for await (const chunk of request) { length += chunk.length; if (length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Choose an image smaller than 25 MB.'), { status: 413 }); chunks.push(chunk); }
          const saved = await attachments.save(Buffer.concat(chunks), decodeURIComponent(request.headers['x-file-name'] || 'Screenshot'));
          if (projectId) await projects.assignResource({ kind: 'inbox', path: path.relative(repo, saved.path).replaceAll('\\', '/'), projectId });
          broadcast('workspace-changed', {});
          return json(response, 201, saved);
        }
        const data = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await body(request, url.pathname === '/api/files/markdown' ? 12 * 1024 * 1024 : url.pathname === '/api/cards/page' ? 3 * 1024 * 1024 : 256 * 1024) : {};
        if (cardMutation && url.pathname.startsWith('/api/workspace/')) throw Object.assign(new Error('Wait for the card or workspace change before transferring data.'), { status: 409 });
        if (method === 'GET' && url.pathname === '/api/bootstrap') {
          return json(response, 200, { repo, projects: await projects.list(), contentBase: `${files.origin}/view/${files.repoGrant}`, agents: inventory(), sessions: sessions.list(), settings, selectedId, notices, coordinator: coordinator.state, voice: { configured: false, owner: voiceOwner }, voiceHistory, operations: [...coordinator.operations.values(), ...quick.operations.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-30) });
        }
        if (method === 'GET' && url.pathname === '/api/projects') return json(response, 200, await projects.list());
        if (method === 'POST' && url.pathname === '/api/workspace/export/preview') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before exporting.'); await coordinator.saves; return json(response, 200, await projects.serialize(() => portable.reviewExport(data.folder))); }
        if (method === 'POST' && url.pathname === '/api/workspace/export') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before exporting.'); await coordinator.saves; return json(response, 201, await projects.serialize(() => portable.exportTo(data.folder, { chats: data.chats, attachmentToken: data.attachmentToken, approveAttachments: data.approveAttachments === true, skipNative: data.skipNative }))); }
        if (method === 'POST' && url.pathname === '/api/workspace/import/preview') return json(response, 200, await portable.preview(data.path));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/export') return json(response, 201, await projects.serialize(() => snapshots.exportTo(data.folder, data.projectId)));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/preview') return json(response, 200, await snapshots.preview(data.folder));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/update/preview') return json(response, 200, await snapshots.updatePreview(data.folder, data.projectId));
        if (method === 'POST' && ['/api/workspace/snapshot/import', '/api/workspace/snapshot/update'].includes(url.pathname)) {
          if (coordinator.operationPromises.size || sessions.active().length) throw new Error('Close worker chats and wait for Mik before updating or importing a workspace snapshot.');
          const imported = url.pathname.endsWith('/import') ? await snapshots.importFrom(data.folder, data) : await snapshots.update(data.folder, data.projectId);
          broadcast('workspace-changed', {}); broadcast('projects-changed', {});
          return json(response, 200, imported);
        }
        if (method === 'POST' && url.pathname === '/api/workspace/import') {
          if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before importing.');
          await coordinator.saves; await coordinator.disconnect();
          const imported = await projects.serialize(() => portable.importFrom(data.path, { relinks: data.relinks, replaceNative: data.replaceNative, replaceHub: data.replaceHub, restoreSettings: data.restoreSettings === true, skipNative: data.skipNative, reviewHash: data.reviewHash }));
          if (imported.restoredSettings) {
            const restored = { ...imported.restoredSettings };
            if (restored.defaultAgent && !inventory().some(agent => agent.id === restored.defaultAgent && agent.available)) delete restored.defaultAgent;
            Object.assign(settings, restored); await saveSettings(); broadcast('settings', { settings });
          }
          broadcast('workspace-changed', {}); broadcast('projects-changed', {});
          await coordinator.init(); coordinator.threads.clear(); coordinator.usedThreads.clear();
          return json(response, 200, imported);
        }
        if (method === 'GET' && url.pathname === '/api/hub/skills') return json(response, 200, await projects.hubSkills(url.searchParams.get('projectId') || null, url.searchParams.get('agent') || 'codex'));
        if (method === 'GET' && url.pathname === '/api/opencode/scopes') return json(response, 200, await openCodeSettings.list(url.searchParams.get('projectId') || null, url.searchParams.get('repositoryId') || null));
        if (method === 'POST' && url.pathname === '/api/opencode/scopes') return json(response, 200, await openCodeSettings.change({ ...data, action: 'toggle' }));
        if (method === 'GET' && url.pathname === '/api/opencode/mcp-managed') return json(response, 200, await openCodeSettings.managed(url.searchParams.get('projectId') || null, url.searchParams.get('repositoryId') || null, url.searchParams.get('scope') || 'project'));
        if (method === 'POST' && url.pathname === '/api/opencode/mcp-managed') return json(response, 200, await openCodeSettings.change({ ...data, kind: 'mcp' }));
        if (method === 'POST' && url.pathname === '/api/hub/skills/scope') return json(response, 200, await projects.setHubSkillScope(data));
        if (method === 'POST' && url.pathname === '/api/skills/create') return json(response, 201, await projects.createSkill(data));
        if (method === 'POST' && url.pathname === '/api/chats/quick') {
          const project = data.projectId ? await projects.get(data.projectId) : null;
          const card = data.cardId ? (await registry()).entities.find(item => item.id === data.cardId && (item.projectId || null) === (project?.id || null)) : null;
          if (data.cardId && !card) throw new Error('Card is not associated with this workspace.');
          const linked = card?.repositoryId ? project?.repositories.find(item => item.id === card.repositoryId) : null;
          if (card?.repositoryId && !linked?.available) throw new Error('The card’s linked project folder is unavailable. Choose a working project in New chat.');
          let name = 'Workspace planning';
          if (card) { try { name = englishTitle(card.title, 'Card chat'); } catch { name = 'Card chat'; } }
          const agent = data.agent || 'codex';
          if (!['codex', 'claude', 'opencode'].includes(agent)) throw new Error('Choose Codex, Claude or OpenCode for a quick chat.');
          const session = await sessions.create(await sessionOptions({ agent, name, projectId: project?.id || null, cardId: card?.id || null, repositoryId: linked?.id || 'hub', cwd: project ? undefined : repo, effort: workerDefault(settings, agent), bypass: settings.defaultBypass }));
          focus(session.id);
          return json(response, 201, session);
        }
        if (method === 'POST' && url.pathname === '/api/chats/compose') {
          if (data.projectId) await projects.get(data.projectId);
          if (data.cardId && !(await registry()).entities.some(item => item.id === data.cardId && item.projectId === data.projectId)) throw new Error('Card is not associated with this project.');
          show('chats', { compose: { projectId: data.projectId || null, cardId: data.cardId || null } });
          return json(response, 200, { opened: true });
        }
        if (method === 'GET' && url.pathname === '/api/codex/scopes') return json(response, 200, await codexScopes.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'GET' && url.pathname === '/api/codex/effective') return json(response, 200, await effectiveCodex(await projects.root(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')), { ...process.env, ...(mcpOptions?.env || {}) }));
        if (method === 'POST' && url.pathname === '/api/codex/scopes') return json(response, 200, await codexScopes.set(data.projectId, data));
        if (method === 'GET' && url.pathname === '/api/codex/mcp-managed') return json(response, 200, await codexMcpEditor.list(url.searchParams.get('scope'), url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'POST' && url.pathname === '/api/codex/mcp-managed') return json(response, 200, await codexMcpEditor.change(data));
        if (method === 'GET' && url.pathname === '/api/claude/mcp-managed') return json(response, 200, await claudeMcpEditor.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId'), url.searchParams.get('scope') || 'local'));
        if (method === 'POST' && url.pathname === '/api/claude/mcp-managed') return json(response, 200, await claudeMcpEditor.change(data));
        if (method === 'GET' && url.pathname === '/api/claude/scopes') return json(response, 200, await claudeSettings.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'POST' && url.pathname === '/api/claude/scopes') return json(response, 200, await claudeSettings.set(data.projectId, data));
        if (method === 'POST' && url.pathname === '/api/projects') return json(response, 201, await projects.save(data));
        if (method === 'POST' && url.pathname === '/api/projects/example') return json(response, 201, await addExampleWorkspace(projects));
        if (method === 'POST' && url.pathname === '/api/projects/repositories') return json(response, 201, await projects.saveRepository(data));
        if (method === 'POST' && url.pathname === '/api/projects/repositories/remove') {
          if (sessions.list().some(item => item.open && item.projectId === data.projectId && item.repositoryId === data.repositoryId)) throw Object.assign(new Error('Close chats working in this linked project before removing its registration.'), { status: 409 });
          return json(response, 200, await changeCards(async () => {
            if (data.cardAction === 'delete') {
              const affected = (await registry()).entities.filter(card => card.projectId === data.projectId && card.repositoryId === data.repositoryId).map(card => card.id);
              if (sessions.list().some(item => item.open && affected.includes(item.cardId))) throw Object.assign(new Error('Close chats associated with these cards before deleting them.'), { status: 409 });
            }
            const result = await projects.removeRepository(data);
            await detachChats(item => item.projectId === data.projectId && item.repositoryId === data.repositoryId, { repositoryId: null });
            if (data.cardAction === 'delete') await detachChats(item => result.cardIds.includes(item.cardId), { cardId: null });
            return result;
          }));
        }
        if (method === 'GET' && url.pathname === '/api/projects/ide') return json(response, 200, { ide: installedIde()?.name || null });
        if (method === 'POST' && url.pathname === '/api/projects/open-ide') return json(response, 200, await openIde(await projects.root(data.projectId)));
        const projectRoute = /^\/api\/projects\/([\w-]+)$/.exec(url.pathname);
        if (projectRoute && method === 'GET') return json(response, 200, await projects.inspect(projectRoute[1]));
        if (projectRoute && method === 'DELETE') {
          if (sessions.list().some(item => item.open && item.projectId === projectRoute[1])) throw Object.assign(new Error('Close this workspace’s chats before removing its registration.'), { status: 409 });
          return json(response, 200, await changeCards(async () => {
            const result = await projects.remove(projectRoute[1], data);
            await detachChats(item => item.projectId === projectRoute[1], { projectId: null, repositoryId: null, ...(data.cardAction === 'delete' ? { cardId: null } : {}) });
            if (settings.selectedProjectId === projectRoute[1]) { settings.selectedProjectId = null; scheduleSettings(); broadcast('settings', { settings }); }
            return result;
          }));
        }
        if (method === 'POST' && url.pathname === '/api/cards/delete') {
          if (data.confirm !== true) throw new Error('Confirm deletion of this card.');
          if (sessions.list().some(item => item.open && item.cardId === data.id)) throw Object.assign(new Error('Close this card’s chats before deleting it.'), { status: 409 });
          return json(response, 200, await changeCards(async () => {
            const result = await projects.removeCard(data.id);
            await detachChats(item => item.cardId === data.id, { cardId: null }); return result;
          }));
        }
        if (method === 'POST' && url.pathname === '/api/cards/status') return json(response, 200, await projects.serialize(() => workspace.update(data.id, { status: data.status, ...(data.status === 'archived' ? { pinned: false } : {}) })));
        if (method === 'POST' && url.pathname === '/api/cards/assign') return json(response, 200, await projects.assignCard(data.id, data.projectId));
        if (method === 'POST' && url.pathname === '/api/cards/repository') return json(response, 200, await projects.assignCardRepository(data.id, data.repositoryId));
        if (method === 'POST' && url.pathname === '/api/cards') return json(response, 201, await projects.createCard(data));
        if (method === 'POST' && url.pathname === '/api/cards/note') return json(response, 201, await projects.addCardNote(data));
        if (method === 'POST' && url.pathname === '/api/cards/page') return json(response, 201, await projects.addCardPage(data));
        if (method === 'PUT' && url.pathname === '/api/cards/page') return json(response, 200, await projects.updateCardPage(data));
        if (method === 'POST' && url.pathname === '/api/cards/asset') return json(response, 201, await projects.importCardAsset(data));
        if (method === 'POST' && url.pathname === '/api/cards/artifact') return json(response, 201, await projects.linkArtifact(data));
        if (method === 'GET' && url.pathname === '/api/cards/artifact/preview') return json(response, 200, await files.preview(await projects.artifactLocation(url.searchParams.get('projectId'), url.searchParams.get('id'), url.searchParams.get('path'), url.searchParams.get('repositoryId'))));
        if (method === 'GET' && url.pathname === '/api/resources') return json(response, 200, await projects.resources(url.searchParams.get('kind'), url.searchParams.get('projectId') || '', url.searchParams.get('scope') || 'all'));
        if (method === 'GET' && url.pathname === '/api/resources/location') {
          const item = (await projects.resources(url.searchParams.get('kind'), '', 'all')).find(resource => resource.id === url.searchParams.get('id'));
          if (!item) throw new Error('Resource was not found.');
          return json(response, 200, { path: await projects.resourceLocation(item) });
        }
        if (method === 'POST' && url.pathname === '/api/resources/assign') return json(response, 200, await projects.assignResource(data));
        if (method === 'POST' && url.pathname === '/api/resources/unlink') return json(response, 200, await projects.unlinkResource(data.kind, data.id));
        if (method === 'POST' && url.pathname === '/api/resources/recycled') return json(response, 200, await projects.cleanupRecycledResource(data.path));
        if (method === 'POST' && url.pathname === '/api/resources/link') return json(response, 201, await projects.linkDocument(data));
        if (method === 'POST' && url.pathname === '/api/resources/import') return json(response, 201, await projects.importResource(data));
        if (method === 'GET' && url.pathname === '/api/resources/preview') {
          const resource = (await projects.resources(url.searchParams.get('kind'), '', 'all')).find(item => item.id === url.searchParams.get('id'));
          if (!resource) throw new Error('Resource was not found.');
          return json(response, 200, await files.preview(await projects.resourceLocation(resource)));
        }
        if (method === 'GET' && url.pathname === '/api/workspace') return json(response, 200, await registry());
        if (method === 'POST' && url.pathname === '/api/cards/pin') {
          if (typeof data.pinned !== 'boolean') throw new Error('Choose a pin state.');
          return json(response, 200, await projects.serialize(() => workspace.update(data.id, { pinned: data.pinned })));
        }
        if (method === 'GET' && url.pathname === '/api/native/settings') return json(response, 200, nativeSettings.value);
        if (method === 'GET' && url.pathname === '/api/accounts') return json(response, 200, await accounts.inventory());
        if (method === 'POST' && url.pathname === '/api/accounts/plan') return json(response, 200, accounts.plan(data.agent, data.action, data.provider));
        if (method === 'POST' && url.pathname === '/api/accounts/confirm') return json(response, 200, await accounts.confirm(data.token));
        if (method === 'GET' && url.pathname === '/api/mcp') return json(response, 200, await (await projectMcp(url.searchParams.get('projectId'), url.searchParams.get('repositoryId'))).list());
        if (method === 'POST' && url.pathname === '/api/mcp/check') return json(response, 200, await (await projectMcp(data.projectId, data.repositoryId)).check(data.id));
        if (method === 'POST' && url.pathname === '/api/native/settings') return json(response, 200, await nativeSettings.set(data.winKey));
        if (method === 'GET' && url.pathname === '/api/history') return json(response, 200, history(url.searchParams.get('q') || ''));
        if (method === 'POST' && url.pathname === '/api/history/import') return json(response, 201, await sessions.importConversation(await sessionOptions(data)));
        if (method === 'GET' && url.pathname === '/api/files') return json(response, 200, await files.list(url.searchParams.get('path') || repo, url.searchParams.get('mode') || 'main', url.searchParams.get('q') || ''));
        if (method === 'POST' && url.pathname === '/api/files/pick') {
          if (typeof data.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(data.requestId)) throw new Error('Invalid file picker request.');
          native({ type: 'pick-files', window: data.window === 'workspace' ? 'workspace' : 'chats', requestId: data.requestId, ...(data.folder === true ? { folder: true } : {}) });
          return json(response, 200, { requested: true });
        }
        if (method === 'POST' && url.pathname === '/api/files/drag') {
          const paths = await dragFiles(data.paths);
          native({ type: 'drag-files', window: 'workspace', paths });
          return json(response, 200, { requested: true });
        }
        if (method === 'POST' && url.pathname === '/api/files/move') {
          const result = await moveFile(data.path, data.folder);
          broadcast('workspace-changed', {});
          return json(response, 200, result);
        }
        if (method === 'POST' && url.pathname === '/api/files/recycle') {
          const file = await recyclePath(data.path, repo);
          if ((await projects.list()).some(project => project.repositoryPath && within(file, project.repositoryPath))) throw new Error('Registered project roots and their parent folders cannot be deleted here.');
          native({ type: 'recycle-file', path: file });
          return json(response, 200, { requested: true, path: file });
        }
        if (method === 'GET' && url.pathname === '/api/preview') return json(response, 200, await files.preview(url.searchParams.get('path') || ''));
        if (method === 'POST' && url.pathname === '/api/files/markdown') {
          const preview = await files.saveMarkdown(data); broadcast('workspace-changed', {});
          return json(response, 200, preview);
        }
        if (method === 'POST' && url.pathname === '/api/settings') {
          if (data.defaultWorkerEffort !== undefined && !defaultWorkerEfforts.includes(data.defaultWorkerEffort) || data.defaultClaudeWorkerEffort !== undefined && !claudeEfforts.includes(data.defaultClaudeWorkerEffort) || data.coordinatorEffort !== undefined && !defaultWorkerEfforts.includes(data.coordinatorEffort)) throw new Error('Invalid reasoning level.');
          if (data.selectedProjectId !== undefined) { if (data.selectedProjectId) await projects.get(data.selectedProjectId); settings.selectedProjectId = data.selectedProjectId || null; }
          if (inventory().some(item => item.id === data.defaultAgent)) settings.defaultAgent = data.defaultAgent;
          if (data.defaultCodexPermissions != null) codexPermissionMode(data.defaultCodexPermissions);
          if (typeof data.defaultBypass === 'boolean') settings.defaultBypass = data.defaultBypass;
          if (data.defaultCodexPermissions != null) settings.defaultCodexPermissions = data.defaultCodexPermissions;
          if (defaultWorkerEfforts.includes(data.defaultWorkerEffort)) settings.defaultWorkerEffort = data.defaultWorkerEffort;
          if (claudeEfforts.includes(data.defaultClaudeWorkerEffort)) settings.defaultClaudeWorkerEffort = data.defaultClaudeWorkerEffort;
          if (Number.isInteger(data.terminalFontSize) && data.terminalFontSize >= 10 && data.terminalFontSize <= 24) settings.terminalFontSize = data.terminalFontSize;
          if (['focus', 'original'].includes(data.terminalAppearance)) settings.terminalAppearance = data.terminalAppearance;
          if (['rose', 'violet', 'blue', 'teal'].includes(data.accentTheme)) settings.accentTheme = data.accentTheme;
          if (defaultWorkerEfforts.includes(data.coordinatorEffort)) settings.coordinatorEffort = data.coordinatorEffort;
          await saveSettings(); broadcast('settings', { settings }); return json(response, 200, settings);
        }
        if (method === 'POST' && url.pathname === '/api/sessions') { const session = await sessions.create(await sessionOptions({ ...data, codexPermissions: data.codexPermissions ?? (typeof data.bypass === "boolean" ? codexPermissionMode(undefined, data.bypass) : undefined), effort: data.effort ?? workerDefault(settings, data.agent), bypass: data.bypass ?? settings.defaultBypass })); focus(session.id); return json(response, 201, session); }
        const modelRoute = /^\/api\/sessions\/([\w-]+)\/model-picker$/.exec(url.pathname);
        const effortRoute = /^\/api\/sessions\/([\w-]+)\/reasoning-picker$/.exec(url.pathname);
        if (method === 'POST' && effortRoute) {
          const agent = sessions.get(effortRoute[1]).agent;
          const picker = agent === 'opencode' ? openCodePicker : agent === 'claude' ? claudeEffortPicker : modelPicker;
          return json(response, 200, data.action === 'open' ? await picker.openEffort(effortRoute[1]) : data.action === 'choose' ? await picker.chooseEffort(effortRoute[1], data.effort) : await picker.cancelEffort(effortRoute[1]));
        }
        if (method === 'POST' && modelRoute) {
          if (!['open', 'choose', 'cancel'].includes(data.action)) throw new Error('Unknown model picker action.');
          const agent = sessions.get(modelRoute[1]).agent;
          const picker = agent === 'opencode' ? openCodePicker : agent === 'claude' ? claudeModelPicker : modelPicker;
          return json(response, 200, data.action === 'open' ? await picker.open(modelRoute[1]) : data.action === 'choose' ? await picker.choose(modelRoute[1], data.model) : await picker.cancel(modelRoute[1]));
        }
        const sessionRoute = /^\/api\/sessions\/([\w-]+)(?:\/(\w+))?$/.exec(url.pathname);
        if (sessionRoute) {
          const [, id, action] = sessionRoute;
          if (method === 'GET' && action === 'screen') return json(response, 200, await sessions.read(id));
          if (method === 'POST' && action === 'focus') return json(response, 200, focus(id));
          if (method === 'POST' && action === 'toolsrefresh') return json(response, 200, await toolRefresh.apply(id));
          if (method === 'POST' && action === 'fork') {
            const source = sessions.get(id);
            if (!['codex', 'claude', 'opencode'].includes(source.agent) || !source.nativeId || source.activity !== 'idle') throw new Error('Fork requires an idle agent chat with a captured native conversation ID.');
            const transcript = source.agent === 'opencode' ? source.nativeId : source.agent === 'codex' ? await codexTranscript(source.nativeId) : await claudeTranscript(source.cwd, source.nativeId, { search: true });
            if (!transcript) throw new Error('The native conversation cannot be located. Reconnect it before forking.');
            const fork = await sessions.create(await sessionOptions({ agent: source.agent, name: `Fork · ${source.name}`, projectId: source.projectId, repositoryId: source.repositoryId || 'hub', cardId: source.cardId, cwd: source.cwd, bypass: source.bypass, codexPermissions: source.codexPermissions, effort: source.effort, resumeId: source.nativeId, fork: true, forkPath: transcript }));
            focus(fork.id); return json(response, 201, fork);
          }
          if (method === 'POST' && action === 'control') {
            const session = sessions.get(id);
            if (!session.process || !['codex', 'claude', 'opencode'].includes(session.agent)) throw new Error('Control requires a running agent terminal.');
            if (data.action === 'interrupt') {
              if (session.activity !== 'working') throw new Error('This chat is not reporting an active turn.');
              if (session.agent === 'opencode') { await openCodePicker.command(id, 'interrupt'); return json(response, 200, { interrupted: true }); }
              return json(response, 200, sessions.input(id, '\x1b'));
            }
            if (data.action !== 'submit' || session.activity === 'working' || session.attention) throw new Error('The terminal is not ready to submit. Handle native prompts directly.');
            if (session.agent === 'opencode') { await openCodePicker.command(id, 'submit'); return json(response, 200, { submitted: true }); }
            return json(response, 200, sessions.input(id, '\r'));
          }
          if (method === 'POST' && action === 'permissions') return json(response, 200, await sessions.setCodexPermissions(id, data.codexPermissions));
          if (method === 'POST' && action === 'stop') return json(response, 200, sessions.stop(id));
          if (method === 'POST' && action === 'resume') { const session = await sessions.resume(id, data.nativeId); focus(id); return json(response, 200, session); }
          if (method === 'POST' && action === 'attach') return json(response, 200, await attach(id, data.paths));
          if (method === 'POST' && action === 'clear') return json(response, 200, await sessions.clearScreen(id));
          if (method === 'POST' && action === 'archive') return json(response, 200, await sessions.archive(id, data.archived));
          if (method === 'POST' && action === 'deleteplan') return json(response, 200, await nativeDeletion.plan(id));
          if (method === 'POST' && action === 'deletenative') return json(response, 200, await nativeDeletion.confirm(id, data.token, data.name));
          if (method === 'POST' && action === 'reorder') return json(response, 200, await sessions.reorder(id, data.targetId, data.position));
          if (method === 'POST' && action === 'input') return json(response, 200, sessions.input(id, data.text, { coordinator: data.paste !== false, submit: data.submit !== false }));
          if (method === 'PATCH' && !action && 'projectId' in data) {
            const session = sessions.get(id);
            const project = data.projectId ? await projects.get(data.projectId) : null;
            const repository = project?.repositories.find(item => item.available && item.repositoryPath.toLowerCase() === (session.cwd || '').toLowerCase());
            if (project && !repository && ![projectChatFolder(project.id), legacyProjectChatFolder(project.id)].some(folder => folder.toLowerCase() === session.cwd.toLowerCase())) throw new Error('This conversation belongs to a different working folder.');
            bridge.revoke(id); session.projectId = project?.id || null; session.repositoryId = repository?.id || null; session.cardId = null; sessions.changed(session); await sessions.persist();
            return json(response, 200, sessions.list().find(item => item.id === id));
          }
          if (method === 'PATCH' && !action) return json(response, 200, typeof data.pinned === 'boolean' ? sessions.pin(id, data.pinned) : 'tabColor' in data ? sessions.color(id, data.tabColor) : sessions.rename(id, data.name));
          if (method === 'DELETE' && !action) return json(response, 200, await closeChat(id));
          if (method === 'DELETE' && action === 'forget') return json(response, 200, await sessions.forget(id));
        }
        if (method === 'POST' && url.pathname === '/api/window') {
          if (!['chats', 'workspace'].includes(data.window) || !['show', 'hide', 'minimize', 'pin', 'layout'].includes(data.action)) throw new Error('Unknown window action');
          native({ type: 'window', action: data.action, window: data.window, value: !!data.value }); return json(response, 200, { requested: true });
        }
        if (method === 'POST' && url.pathname === '/api/reveal') {
          const file = await realpath(path.resolve(data.path));
          native({ type: 'reveal', path: file }); return json(response, 200, { requested: true });
        }
        if (method === 'GET' && url.pathname === '/api/coordinator') {
          const projectId = url.searchParams.get('projectId') || null;
          const conversations = coordinator.conversations.conversations.filter(item => item.projectId === projectId).map(({ id, title, at, parentId, threadId, nativeUnavailable }) => ({ id, title, at, parentId, nativeUnavailable: nativeUnavailable || null, canFork: !!threadId && !nativeUnavailable }));
          if (coordinator.history(projectId, 'legacy').length) conversations.unshift({ id: 'legacy', title: 'Previous Mak History · view only', at: '', canFork: false });
          const selected = coordinator.conversations.selected[projectId || 'global'] || (conversations.some(item => item.id === 'legacy') ? 'legacy' : null);
          const current = selected && selected !== 'legacy' ? coordinator.conversation(projectId, selected) : null;
          return json(response, 200, { history: selected ? coordinator.history(projectId, selected) : [], conversations, selected, effort: current?.effort || settings.coordinatorEffort, model: current?.model || null, state: coordinator.state, confirmations: [...coordinator.confirmations.values()].map(item => item.confirmation), active: coordinator.active?.operationId || null });
        }
        if (method === 'GET' && url.pathname === '/api/reasoning') {
          const result = { codex: { model: '', efforts: [], defaultEffort: 'medium' }, codexWorker: { model: '', efforts: [], defaultEffort: 'medium' }, claude: { efforts: claudeEfforts, note: 'Native Claude effort levels; model and organization limits are enforced by Claude.' } };
          const errors = [];
          try { result.codex = await coordinator.reasoningCapabilities(url.searchParams.get('model') || undefined); } catch (error) { errors.push(publicError(error)); }
          try { result.codexWorker = await coordinator.reasoningCapabilities(undefined, { worker: true }); } catch (error) { errors.push(publicError(error)); }
          return json(response, 200, { ...result, ...(errors.length ? { error: errors.join(' ') } : {}) });
        }
        if (method === 'POST' && url.pathname === '/api/coordinator/conversation') {
          const projectId = data.projectId || null; if (projectId) await projects.get(projectId);
          if (data.action === 'model') return json(response, 200, await coordinator.setModel(projectId, data.id, data.model));
          if (data.action === 'effort') return json(response, 200, await coordinator.setEffort(projectId, data.id, data.effort));
          if (data.action === 'retry') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak before reconnecting.'); const conversation = coordinator.conversation(projectId); if (!conversation) throw new Error('Create a conversation first.'); await coordinator.start(); await coordinator.ensureThread({ projectId }, conversation); return json(response, 200, { ready: true }); }
          return json(response, 200, data.action === 'select' ? await coordinator.selectConversation(projectId, data.id) : data.action === 'new' || data.action === 'fork' ? await coordinator.newConversation(projectId, data.action === 'fork') : (() => { throw new Error('Unknown conversation action.'); })());
        }
        if (method === 'POST' && url.pathname === '/api/coordinator') return json(response, 200, await askMak(data));
        if (method === 'POST' && url.pathname === '/api/coordinator/confirm') return json(response, 200, coordinator.confirm(data.id, data.approved));
        if (method === 'POST' && url.pathname === '/api/coordinator/cancel') return json(response, 200, await coordinator.cancel(data.id));
        if (method === 'POST' && url.pathname === '/api/coordinator/prepare') { await coordinator.start(); return json(response, 200, { ready: true, model: coordinator.model }); }
        if (method === 'POST' && url.pathname === '/api/live/transcript') {
          if (typeof data.id !== 'string' || data.id.length > 200 || !Array.isArray(data.captions)) throw new Error('A voice session and captions are required.');
          const captions = data.captions.slice(-50).filter(item => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').map(item => ({ role: item.role, text: item.text.slice(0, 1000), start: Number(item.start) || 0, end: Number(item.end) || 0 }));
          const transcript = { id: data.id, at: new Date().toISOString(), captions };
          voiceHistory = [...voiceHistory.filter(item => item.id !== data.id), transcript].slice(-12);
          const snapshot = voiceHistory;
          transcriptSave = transcriptSave.catch(() => {}).then(() => saveJson(transcriptPath, snapshot)); await transcriptSave;
          return json(response, 200, { saved: true });
        }
        if (method === 'POST' && url.pathname === '/api/live/release') {
          if (voiceOwner?.clientId === data.clientId) { voiceOwner = null; broadcast('voice-owner', { owner: null }); }
          return json(response, 200, { released: true });
        }
        throw Object.assign(new Error('Endpoint not found'), { status: 404 });
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Not allowed'), { status: 405 });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const { file, info } = await realFile(uiDir, relative);
      if (!info.isFile()) throw new Error('File not found');
      await serveFile(request, response, file, info, {
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: ${files.origin}; media-src 'self' blob: ${files.origin}; connect-src 'self' ws://127.0.0.1:* ${files.origin}; frame-src ${files.origin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
      });
    } catch (error) { if (!response.headersSent) json(response, error.status || 400, { error: publicError(error) }); }
  });
  const origin = await listen(server);
  files.uiOrigin = origin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, origin);
    if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin || url.pathname !== '/events') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.authenticated = false; ws.sessionId = null;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!ws.authenticated) {
          if (message.type !== 'auth' || !equalSecret(message.token, token)) return ws.close(1008, 'Authentication failed');
          ws.authenticated = true; ws.clientId = message.clientId; ws.surface = message.surface; clients.add(ws); clearTimeout(authTimer);
          send(ws, 'connected', { sessions: sessions.list(), selectedId, coordinator: coordinator.state }); return;
        }
        if (message.type === 'subscribe') {
          ws.sessionId = message.id;
          const snapshot = await sessions.snapshot(message.id);
          if (ws.sessionId === message.id) send(ws, 'snapshot', snapshot);
        } else if (message.type === 'input') sessions.input(message.id, message.data);
        else if (message.type === 'resize') sessions.resize(message.id, message.cols, message.rows);
        else if (message.type === 'selected') { sessions.get(message.id); selectedId = message.id; settings.selectedId = selectedId; scheduleSettings(); }
        else if (message.type === 'seen' && ws.surface === 'chats' && ws.sessionId === message.id && selectedId === message.id) sessions.seen(message.id, message.completionVersion);
        else if (message.type === 'workspace-route') { workspaceRoute = String(message.route || '').slice(0, 500); settings.workspaceRoute = workspaceRoute; scheduleSettings(); }
        else if (message.type === 'ping') send(ws, 'pong', {});
      } catch (error) { send(ws, 'service-error', { error: publicError(error) }); }
    });
    ws.on('close', () => { clearTimeout(authTimer); clients.delete(ws); if (voiceOwner?.clientId === ws.clientId) { voiceOwner = null; broadcast('voice-owner', { owner: null }); } });
    ws.on('error', () => {});
  });
  let watcher;
  try { watcher = watch(path.join(repo, 'workspace', 'workspace.json'), () => broadcast('workspace-changed', {})); watcher.on('error', () => {}); } catch { /* Registry may be created after first setup. */ }
  const restoreTimer = restoreSessions ? setTimeout(() => sessions.restore().catch(error => sessions.emit('service-error', error)), 100) : null;
  return {
    origin, contentOrigin: files.origin, token, sessions, coordinator, quick, workspace, files, projects, bridge, toolRefresh,
    urls: { workspace: `${origin}/?desktop=1&surface=workspace&token=${token}`, chats: `${origin}/?desktop=1&surface=chats&token=${token}` },
      nativeMessage: event => { nativeSettings.receive(event); cardRecycler.receive(event); },
      async close() {
        if (closing) return; closing = true; toolRefresh.close(); bridge.close(); cardRecycler.close(); for (const inventory of projectMcps.values()) inventory.close(); await projects.writes.catch(() => {}); mcp.close(); nativeSettings.close(); await files.writes.catch(() => {});
      watcher?.close(); clearTimeout(restoreTimer); coordinator.close(); clearTimeout(settingsTimer); await saveSettings(); await transcriptSave; await coordinator.queue; await coordinator.saves; await quick.saves; await workspace.writes;
      for (const ws of wss.clients) ws.terminate();
      wss.close(); await sessions.close();
      server.closeAllConnections(); contentServer.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => contentServer.close(resolve))]);
    },
  };
}
