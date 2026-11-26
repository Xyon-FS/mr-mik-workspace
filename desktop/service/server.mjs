import { attachmentPreview } from './chat-attachment-preview.mjs';
import { claudePlatformMcps } from './claude-platform-mcps.mjs';
import { settleCleanup } from './shutdown.mjs';
import { workspaceIcon, saveWorkspaceIcon, workspaceIconPrompt, workspaceIconOutputs } from './workspace-icon.mjs';
import { validateChatShortcuts } from './chat-shortcuts.mjs';
import { bundleHtml } from './html-bundle.mjs';
import { conversationResults, messageResults } from './chat-results.mjs';
import http from 'node:http';
import { graphicalSync } from './graphical-sync.mjs';
import { chatBlockPreview, previewViewState } from './chat-block-preview.mjs';
import { resolveChatCardOutput, saveChatCardOutput } from './chat-card-output.mjs';
import { createHash } from 'node:crypto';
import { CLAUDE_IMAGE_BYTES } from './claude-chat-attachments.mjs';
import { appVersion } from './app-version.mjs';
import { CompactConversations } from './compact-conversation.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { accountLimits, AccountLimitsReader } from './account-limits.mjs';
import { readFile, stat, realpath, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseEnv } from 'dotenv';
import { parse as parseToml } from 'smol-toml';
import { resultBytes } from './chat-result-content.mjs';
import { Sessions } from './sessions.mjs';
import { CodexPreparation } from './codex-preparation.mjs';
import { codexPreparationLaunch } from './codex-worker-launch.mjs';
import { claudeGraphicalActions } from './graphical-capabilities.mjs';
import { relocatedSessionCwd } from './session-location.mjs';
import { browserChoices, browserChoice, managedBrowserDefinition, browserOrientation } from './managed-browser.mjs';
import { SharedBrowsers, sharedBrowserOrientation } from './shared-browser.mjs';
import { BrowserSettings, browserConfiguration } from './browser-settings.mjs';
import { inspectItem, inspectFile, quoteRecordedDiff } from './chat-inspector.mjs';
import { createMessageBranch, prepareMessageAction } from './chat-message-actions.mjs';
import { createClaudeMessageBranch, prepareClaudeMessageAction } from './claude-message-actions.mjs';
import { providerMessageReceipt } from './provider-message-receipts.mjs';
import { OpenCodeMessageActions } from './opencode-message-actions.mjs';
import { NativeControls } from './native-controls.mjs';
import { CardContentSync } from './card-content-sync.mjs';
import { codexPermissionMode } from './codex-permissions.mjs';
import { CodexModelPicker } from './model-picker.mjs';
import { ClaudeModelPicker, ClaudeEffortPicker } from './claude-model-picker.mjs';
import { ClaudeCliPermissions } from './claude-cli-permissions.mjs';
import { OpenCodePicker } from './opencode-picker.mjs';
import { Accounts } from './accounts.mjs';
import { AccountProfiles } from './account-profiles.mjs';
import { ClaudeProfiles } from './claude-profiles.mjs';
import { NativeProfileProbe } from './codex-profile-probe.mjs';
import { CodexCliVerifier } from './codex-cli-verifier.mjs';
import { withCodexStoreStartup } from './codex-profile-layout.mjs';
import { Coordinator } from './coordinator.mjs';
import { MakActions } from './mak-actions.mjs';
import { workerControls } from './worker-controls.mjs';
import { ToolRefresh, mcpSnapshot, emptyNativePrompt } from './tool-refresh.mjs';
import { nativeRefreshSnapshot } from './native-refresh-snapshot.mjs';
import { codexTranscript, claudeTranscript } from './native-events.mjs';
import { Files, serveFile } from './files.mjs';
import { importFile, dragFiles, moveFile, recyclePath, MAX_FILE_BYTES } from './file-transfers.mjs';
import { inventory } from './agents.mjs';
import { Attachments, attachmentText, describeAttachment, MAX_IMAGE_BYTES, imageExtension } from './attachments.mjs';
import { resolveConversationMedia } from './conversation-media.mjs';
import { ContextLibrary } from './context.mjs';
import { englishTitle, taskTitle } from './titles.mjs';
import { defaultWorkerEffort, defaultWorkerEfforts, claudeEfforts, workerDefault, taskEffort } from './effort.mjs';
import { Workspace, localDay } from './workspace.mjs';
import { QuickActions } from './quick-actions.mjs';
import { defaultVoiceStyle } from './voice-profile.mjs';
import { NativeSettings } from './native-settings.mjs';
import { McpInventory } from './mcp.mjs';
import { McpRecovery } from './mcp-recovery.mjs';
import { mcpPreflight } from './mcp-preflight.mjs';
import { connectionIssue } from './connection-errors.mjs';
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
import { resolveWorkspaceMcps, WorkspaceMcpLaunches } from './workspace-mcps.mjs';
import { ClaudeSettings } from './claude-settings.mjs';
import { OpenCodeSettings } from './opencode-settings.mjs';
import { installedIde, openIde } from './ide.mjs';
import { resolveChatFileLink } from './chat-file-link.mjs';
import { isDevelopmentFile } from './development-files.mjs';
import { body, equalSecret, json, publicError, readJson, realFile, saveJson, secret, within } from './util.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });

export async function createService({ repo, uiDir, stateDir, token = secret(), native = () => {}, restoreSessions = false, reportStartup, mcpOptions, profileOptions, browserOptions }) {
  repo = await realpath(repo);
  stateDir ||= path.join(repo, '.mrmak');
  const files = new Files(repo);
  const attachments = new Attachments(repo);
  const library = new ContextLibrary(repo);
  const mcp = new McpInventory(repo, mcpOptions);
  const sessions = await new Sessions(repo, stateDir).init();
  // Operational escape hatch; does not change native account configuration.
  sessions.codexWorkers.configure({ maxIdle: process.env.MRMIK_CODEX_WARM_START === 'off' ? 0 : 2 });
  let activeInspection = null;
  const sharedBrowsers = new SharedBrowsers({ stateDir, hub: repo, ...(mcpOptions?.home ? { profileRoot: path.join(mcpOptions.home, 'browser-profiles') } : {}), ...browserOptions, session: id => sessions.items.get(id), onOpen: id => { sharedBrowsers.selectedId = id; show('workspace', { browserSessionId: id }); }, onError: error => sessions.emit('service-error', error) });
  sessions.requireExplicitAccount = true;
  const profiles = new AccountProfiles({ ...profileOptions, ...(mcpOptions?.env ? { env: { ...process.env, ...mcpOptions.env } } : {}), ...(mcpOptions?.home ? { home: mcpOptions.home } : {}) });
  const codexCliVerifier = new CodexCliVerifier({ onCleanupError: error => sessions.emit('service-error', error) });
  const claudeProfiles = new ClaudeProfiles({ root: profiles.root, env: profiles.env, home: profiles.home, identity: profileOptions?.claudeIdentity });
  profiles.migrationBusy = () => [...sessions.items.values()].some(item => item.agent === 'codex' && !!item.process) || !!coordinator.child;
  sessions.accountContext = session => session.agent === 'codex' ? profiles.context(session.accountProfileId || 'system', session.projectId ? session.cwd : repo) : session.agent === 'claude' ? claudeProfiles.forSession(session, session.projectId ? session.cwd : repo) : null;
  sessions.verifyIdentity = session => session.agent === 'codex' ? profiles.assertIdentity(session.accountProfileId) : session.agent === 'claude' ? claudeProfiles.verify(session) : undefined;
  const compactConversations = new CompactConversations((id, session) => sessions.codexFile(session, id));
  const modelPicker = new CodexModelPicker(sessions);
  const openCodePicker = new OpenCodePicker(sessions);
  const profileBlocked = (agent, profileId = 'system') => sessions.list().some(item => item.agent === agent && (item.accountProfileId || 'system') === profileId && (item.open || item.status === 'running')) || agent === 'codex' && (coordinator.runtimeProfileId || 'system') === profileId && coordinator.operationPromises.size > 0;
  const accounts = new Accounts({ profiles, claudeProfiles, blocked: profileBlocked, beforeChange: async (agent, profileId) => { accountLimitReader.invalidate(); if (agent === 'codex') { await codexCliVerifier.invalidate(); await codexPreparation.cancel(); await sessions.codexWorkers.invalidate(profileId); } if (agent === 'codex' && (coordinator.runtimeProfileId || 'system') === profileId) await coordinator.disconnect(); } });
  const accountLimitReader = new AccountLimitsReader({ context: async (agent, profileId) => {
    if (accounts.terminalOpen(agent, profileId)) throw new Error('Account action pending.');
    if (agent === 'codex') {
      sessions.requireAccount(profileId);
      if ((await profiles.accountAction())?.profileId === profileId) throw new Error('Account action pending.');
      await profiles.assertIdentity(profileId);
      return { ...await profiles.context(profileId, stateDir), cwd: stateDir };
    }
    if ((await claudeProfiles.accountAction())?.profileId === profileId) throw new Error('Account action pending.');
    const context = await claudeProfiles.context(profileId, stateDir), identity = await claudeProfiles.identity(context.env);
    if (identity.status !== 'logged-in') throw new Error('Sign in first.');
    return { ...context, cwd: stateDir, identityKey: identity.identity || 'native' };
  } });
  sessions.verifyAccount = async (session, context) => {
    if (!context) return;
    if (session.agent === 'claude') {
      if (accounts.terminalOpen('claude', context.profileId) || (await claudeProfiles.accountAction())?.profileId === context.profileId) throw new Error('Finish this Claude profile’s account action first.');
      await claudeProfiles.verify(session, context); return;
    }
    if ((await profiles.accountAction())?.profileId === context.profileId) throw new Error('Finish this account’s sign-in or sign-out before opening a chat.');
    if (accounts.terminalOpen('codex', context.profileId)) throw new Error('Finish this account’s sign-in or sign-out before opening its chats.');
    if (context.system) throw new Error('Choose an added Codex account. Connect one in Settings → Accounts if needed.');
    await profiles.assertIdentity(context.profileId);
    const verifyNative = async probe => {
        const config = await probe.config();
        const resolvedSqlite = typeof config.sqlite_home === 'string' && path.isAbsolute(config.sqlite_home) ? await realpath(config.sqlite_home) : '';
        const matchesStore = process.platform === 'win32' ? resolvedSqlite.toLowerCase() === context.sqliteHome.toLowerCase() : resolvedSqlite === context.sqliteHome;
        if (config.cli_auth_credentials_store !== 'file' || !matchesStore) throw new Error('Native project or managed configuration overrides this profile’s store/auth settings. The chat was not started.');
        const nativeAccount = await probe.account();
        if (!nativeAccount) throw new Error('Sign in to this Codex account profile in Accounts before opening its chat.');
        const identity = await profiles.assertIdentity(context.profileId);
        if (nativeAccount.type !== 'chatgpt' || identity.identityEmail && nativeAccount.email && identity.identityEmail.toLowerCase() !== nativeAccount.email.toLowerCase()) throw new Error('Native Codex reported a different account identity. The chat was not started.');
        if (session.chatInterface === 'cli' && !session.hasConversation) {
          // Reuse the existing read-only verifier; recent native banners omit
          // the initial model. Display metadata never changes launch settings.
          const label = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : await probe.modelLabel?.(config).catch(() => null);
          if (label) session.cliModelLabel = label;
        }
        if (session.chatInterface === 'chat') await profiles.assertCurrentContext(context);
    };
    if (session.chatInterface === 'chat') {
      session.verifyStartupAccount = runtime => verifyNative({
        config: async () => (await runtime.rpc('config/read', { cwd: session.cwd })).config || {},
        account: async () => (await runtime.rpc('account/read', { refreshToken: false })).account,
      });
      return;
    }
    if (session.chatInterface === 'cli') {
      await codexCliVerifier.verify(context, session.cwd, verifyNative);
      return;
    }
    await withCodexStoreStartup(context.sqliteHome, async () => {
      const probe = new NativeProfileProbe(session.cwd, context.env);
      try { await verifyNative(probe); } finally { await probe.close(); }
    });
  };
  const workers = workerControls(sessions, openCodePicker);
  const openCodeMessageActions = new OpenCodeMessageActions(sessions, openCodePicker, workers);
  const nativeControls = new NativeControls(sessions, openCodePicker, openCodeMessageActions);
  const claudeModelPicker = new ClaudeModelPicker(sessions);
  const claudeEffortPicker = new ClaudeEffortPicker(sessions);
  const claudeCliPermissions = new ClaudeCliPermissions(sessions, [claudeModelPicker, claudeEffortPicker]);
  const environment = parseEnv(await readFile(path.join(repo, '.env'), 'utf8').catch(() => ''));
  const settingsPath = path.join(stateDir, 'settings.json');
  let settings = { defaultAgent: 'codex', defaultBypass: false, defaultWorkerEffort, coordinatorModel: environment.MRMAK_COORDINATOR_MODEL?.trim() || null, completionNotifications: true, terminalFontSize: 13, terminalAppearance: 'focus', accentTheme: 'rose', coordinatorEffort: 'medium', voiceName: 'cedar', voiceStyle: defaultVoiceStyle, ...await readJson(settingsPath, {}) };
  settings.chatWidthPercent = Number.isInteger(settings.chatWidthPercent) && settings.chatWidthPercent >= 20 && settings.chatWidthPercent <= 65 ? settings.chatWidthPercent : 30;
  if (!inventory().some(agent => agent.id === settings.defaultAgent)) settings.defaultAgent = 'codex';
  if (!['ask', 'bypass'].includes(settings.defaultClaudePermissions)) settings.defaultClaudePermissions = settings.defaultBypass ? 'bypass' : 'ask';
  const agentBypass = agent => agent === 'claude' ? settings.defaultClaudePermissions === 'bypass' : settings.defaultBypass;
  settings.defaultCodexPermissions = codexPermissionMode(settings.defaultCodexPermissions, settings.defaultBypass);
  if (!browserChoices.includes(settings.managedBrowser)) settings.managedBrowser = 'off';
  settings.managedBrowserHeadless = settings.managedBrowserHeadless === true;
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
  const browserSettings = new BrowserSettings({ settings: () => settings, save: saveSettings, sessions, browsers: sharedBrowsers, projects: { get: id => projects.get(id) }, changed: () => broadcast('settings', { settings }) });
  const transcriptPath = path.join(stateDir, 'voice-transcripts.json');
  let voiceHistory = await readJson(transcriptPath, []);
  let transcriptSave = Promise.resolve();
  let voiceOwner = null;
  let closing = false;
  const clients = new Set();
  const notices = [];
  const send = (ws, type, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...value })); };
  const broadcast = (type, value) => { if (type === 'accounts-changed') accounts.invalidateDisplay(); for (const ws of clients) send(ws, type, value); };
  const nativeSettings = new NativeSettings(native, value => broadcast('native-settings', value));
  const show = (window, extra = {}) => { if (window === 'workspace' && (extra.preview || extra.route !== undefined || extra.browserSessionId)) activeInspection = null; native({ type: 'window', action: 'show', window }); broadcast('navigate', { window, ...extra }); };
  const focus = id => { sessions.get(id); selectedId = id; settings.selectedId = id; scheduleSettings(); show('chats', { sessionId: id }); return { selectedId: id }; };
  const registry = async () => readJson(path.join(repo, 'workspace', 'workspace.json'), { entities: [] });
  const workspace = new Workspace(repo, () => broadcast('workspace-changed', {}));
  const projects = new Projects(repo, stateDir, () => { broadcast('projects-changed', {}); broadcast('workspace-changed', {}); });
  const cardContent = new CardContentSync({ repo, stateDir, registry, projects, changed: pages => broadcast('card-content-changed', { pages }), onError: error => sessions.emit('service-error', error) });
  const cardRecycler = new CardRecycler(native);
  projects.recycleCardFolder = file => cardRecycler.recycle(file);
  const portable = new PortableArchive(repo, stateDir, sessions, projects);
  const snapshots = new WorkspaceSnapshot(repo, stateDir, projects);
  let workspaceTransferBusy = false;
  const runWorkspaceTransfer = async action => {
    if (workspaceTransferBusy) throw Object.assign(new Error('Wait for the current workspace transfer to finish.'), { status: 409 });
    workspaceTransferBusy = true;
    let paused = false;
    try {
      await cardContent.pause(); paused = true;
      clearTimeout(settingsTimer); await settingsSave;
      return await action();
    }
    finally { if (paused) cardContent.resume(); workspaceTransferBusy = false; }
  };
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
  const sessionToolOptions = async () => mcpOptions; // Tools belong to the platform, not its login profile.
  const workspaceMcpLaunches = new WorkspaceMcpLaunches(stateDir);
  const toolRefresh = new ToolRefresh(sessions, {
    watch: true,
    silent: session => ['claude', 'codex'].includes(session.agent),
    snapshot: async session => {
      const options = await sessionToolOptions(session), codexChat = session.agent === 'codex' && session.chatInterface === 'chat';
      const inventory = new McpInventory(session.cwd, options);
      try {
        const scan = await inventory.scan(codexChat ? { client: 'codex' } : {});
        return {
          ...mcpSnapshot(scan, session.agent),
          ...await nativeRefreshSnapshot(session, repo, stateDir, options),
          ...(await resolveWorkspaceMcps(projects, session, options, codexChat ? { ownScan: scan } : {})).snapshot,
        };
      } finally { inventory.close(); }
    },
    ready: async session => {
      if (session.chatInterface === 'chat') { const runtime = session.graphical; if (session.agent === 'codex' && runtime?.idle?.() && runtime.operations?.agentsBusy) await runtime.operations.refreshAgentStatuses(); return runtime?.ready() === true; }
      if (session.nativeControlBusy || [modelPicker, claudeModelPicker, claudeEffortPicker, openCodePicker].some(picker => picker.busy.has(session.id) || picker.openMenus.has(session.id)) || openCodePicker.requests?.has(session.id)) return false;
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
  toolRefresh.wrap(projects, 'saveRepository', () => true);
  toolRefresh.wrap(projects, 'removeRepository', () => true);
  toolRefresh.wrap(files, 'saveMarkdown', () => true);
  const mcpRecovery = new McpRecovery(projects, stateDir, mcpOptions);
  toolRefresh.wrap(mcpRecovery, 'apply', () => true);
  toolRefresh.wrap(mcpRecovery, 'undo', () => true);
  const projectMcps = new Map();
  const claudeTools = async (profileId = 'system') => {
    if (profileId && profileId !== 'system') await claudeProfiles.context(profileId);
    return { editor: claudeMcpEditor, settings: claudeSettings, options: mcpOptions };
  };
  const claudeInventory = async (profileId, projectId, repositoryId) => {
    const options = (await claudeTools(profileId)).options, root = projectId ? await projects.root(projectId, repositoryId) : repo;
    const key = `claude:platform:${root}`, previous = projectMcps.get(key);
    if (previous) return previous;
    const inventory = new McpInventory(root, options); projectMcps.set(key, inventory); return inventory;
  };
  const codexTools = async (profileId = 'system') => {
    // Accounts select credentials, not separate tool installations/configuration.
    if (profileId && profileId !== 'system') await profiles.context(profileId);
    return { scopes: codexScopes, editor: codexMcpEditor, recovery: mcpRecovery, options: mcpOptions };
  };
  const projectMcp = async (id, repositoryId, profileId = 'system') => {
    if (!id && (!profileId || profileId === 'system')) return mcp;
    const options = (await codexTools(profileId)).options;
    if (!id) { const key = `hub:${profileId}`; if (!projectMcps.has(key)) projectMcps.set(key, new McpInventory(repo, options)); return projectMcps.get(key); }
    if (!(await projects.get(id)).repositories.length) { if (!profileId || profileId === 'system') return mcp; throw new Error('Choose a linked project or the Hub for this account’s tools.'); }
    const root = await projects.root(id, repositoryId);
    const key = `${id}:${repositoryId || 'primary'}:${profileId}`;
    const previous = projectMcps.get(key);
    if (previous?.repo === root) return previous;
    previous?.close(); const next = new McpInventory(root, options); projectMcps.set(key, next); return next;
  };
  const bridge = new WorkspaceBridge(projects, workspace, registry, { cardContent, browserSettings: grant => browserSettings.read(sessions.items.get(grant.sessionId), grant.projectId), browserChange: (grant, patch) => browserSettings.change({ ...patch, sessionId: grant.sessionId, projectId: grant.projectId }), browserClear: grant => sharedBrowsers.clearProfile(sharedBrowsers.get(grant.sessionId)).then(() => browserSettings.read(sessions.items.get(grant.sessionId))), cardPreview: plan => files.cardPreview(plan), codexForGrant: async grant => { const session = sessions.items.get(grant.sessionId); if (session?.agent === 'claude') { const tools = await claudeTools(session.accountProfileId); return { claudeMcpEditor: tools.editor, claudeSettings: tools.settings, mcpInventory: async (id, repositoryId) => (await claudeInventory(session.accountProfileId, id, repositoryId)).list() }; } const profileId = session ? session.accountProfileId || 'system' : coordinator.runtimeProfileId || 'system'; const tools = await codexTools(profileId); return { codexScopes: tools.scopes, codexMcpEditor: tools.editor, mcpInventory: async (id, repositoryId) => (await projectMcp(id, repositoryId, profileId)).list() }; }, codexScopes, codexMcpEditor, claudeMcpEditor, claudeSettings, openCodeSettings, mcpInventory: async (id, repositoryId) => (await projectMcp(id, repositoryId)).list() });
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
    if ((options.agent || "codex") === "codex") {
      const inheritedAccount = coordinator.runtimeProfileId && coordinator.runtimeProfileId !== 'system' ? coordinator.runtimeProfileId : sessions.items.get(selectedId)?.accountProfileId;
      options = { ...options, accountProfileId: options.accountProfileId ?? inheritedAccount, codexPermissions: codexPermissionMode(options.codexPermissions ?? settings.defaultCodexPermissions, options.bypass ?? settings.defaultBypass) };
    }
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
  sessions.resolveLocation = session => relocatedSessionCwd(session, projects);
  const codexPreparation = new CodexPreparation({
    pool: sessions.codexWorkers,
    resolve: async input => {
      if (closing || cardMutation || !input || input.agent !== 'codex' || input.chatInterface !== 'chat' || !input.accountProfileId || input.accountProfileId === 'system' || accounts.terminalOpen('codex', input.accountProfileId)) return null;
      let cwd;
      if (input.projectId) {
        const project = await projects.get(input.projectId);
        cwd = input.repositoryId && input.repositoryId !== 'hub' ? await projects.root(project.id, input.repositoryId) : projectChatFolder(project.id);
      } else cwd = input.cardId ? repo : input.cwd || repo;
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) return null;
      const account = await profiles.inspectContext(input.accountProfileId, input.projectId ? cwd : repo);
      if (!account) return null;
      return { account, session: { agent: 'codex', chatInterface: 'chat', cwd, accountProfileId: input.accountProfileId, codexPermissions: codexPermissionMode(input.codexPermissions ?? settings.defaultCodexPermissions, input.bypass ?? settings.defaultBypass) }, sandboxStateDir: path.join(stateDir, 'codex-sandbox') };
    },
    launch: codexPreparationLaunch,
    verify: async ({ session, account }, transport) => {
      await sessions.verifyAccount(session, account);
      await session.verifyStartupAccount({ rpc: (...args) => transport.rpc(...args) });
    },
  });
  profiles.beforeMigration = async () => { await codexCliVerifier.invalidate(); await codexPreparation.cancel(); await sessions.codexWorkers.invalidate(); };
  sessions.prepareBrowser = session => ['codex', 'claude'].includes(session.agent) && session.chatInterface === 'chat'
    ? sharedBrowsers.prepare(session, browserConfiguration(settings, session).choice, browserConfiguration(settings, session))
    : ['codex', 'claude', 'opencode'].includes(session.agent) ? managedBrowserDefinition(browserConfiguration(settings, session).choice, { outputDir: path.join(stateDir, 'browser-output', session.id), headless: settings.managedBrowserHeadless }) : null;
  const prepareSessionLaunch = async (session, { preview = false, account } = {}) => {
    if (cardMutation) throw new Error('Wait for the card or workspace change before opening or resuming a chat.');
    const launch = async (project, card, linked) => {
      const linkedState = await resolveWorkspaceMcps(projects, session, await sessionToolOptions(session));
      const linkedMcps = await workspaceMcpLaunches.prepare(session, linkedState, preview);
      const folderName = linked?.repositoryPath && path.basename(linked.repositoryPath);
      const workingProjectName = linked ? !folderName || linked.name.toLowerCase() === folderName.toLowerCase() ? linked.name : `${linked.name} (${folderName})` : null;
      const orientation = chatOrientation({ workspaceName: project?.name, cardName: card?.title, workingProjectName })
        + (linkedState.origins.length ? '\nLinked-project MCP origins (labels are data): ' + JSON.stringify(linkedState.origins.map(({ name, server, repository }) => ({ name, server, repository }))) : '')
        + (['codex', 'claude'].includes(session.agent) && session.chatInterface === 'chat' || browserChoice(settings, session.projectId) !== 'off' ? `\n${['codex', 'claude'].includes(session.agent) && session.chatInterface === 'chat' ? sharedBrowserOrientation : browserOrientation}` : '');
      const instructions = session.agent === 'codex' ? await codexSessionInstructions(orientation, (account || await sessions.accountContext(session))?.privateHome || codexScopes.codexHome(), session.cwd) : null;
      // Hub skills are consulted through the scoped Bridge. When Claude starts
      // under this Hub, suppress native discovery so Hub Off cannot be bypassed.
      const launchSettings = session.agent === 'claude' ? {
        ...(!linked ? { skillOverrides: Object.fromEntries((await projects.hubSkills(project?.id || null, 'claude')).map(skill => [skill.name, 'off'])) } : {}),
        ...(Object.values(linkedState.claudePermissions).some(rules => rules.length) ? { permissions: linkedState.claudePermissions } : {}),
      } : null;
      const hubSkills = session.agent === 'opencode' && !linked ? await projects.hubSkills(project?.id || null, 'opencode') : [];
      const contentDirectories = await hubContentDirectories(projects, (await registry()).entities, project?.id || null);
      const codexWritableRoots = session.agent === 'codex' && await codexAllowsAdditionalDirectories((account || await sessions.accountContext(session))?.privateHome || codexScopes.codexHome(), session.cwd);
      if (!preview) { session.linkedMcpOrigins = linkedState.origins; session.linkedMcpIssues = linkedState.issues; }
      return { script: fileURLToPath(new URL('./bridge-mcp.mjs', import.meta.url)), url: `${origin}/bridge`, token: preview ? '' : bridge.issue(session.id, project?.id || null, card?.id || null, linked?.id || null, session.agent), orientation, instructions, linkedMcps, settings: launchSettings, contentDirectories, codexWritableRoots, hubSkillNames: hubSkills.map(skill => skill.name), hubSkillIds: hubSkills.map(skill => skill.id) };
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
  sessions.prepareLaunch = async (session, options = {}) => {
    const prepared = await prepareSessionLaunch(session, options);
    if (session.agent !== 'claude' || !session.accountProfileId || session.accountProfileId === 'system' || options.preview) return prepared;
    const servers = await claudePlatformMcps(session.cwd, mcpOptions);
    const claudeMcpFile = await workspaceMcpLaunches.claudePlatform(session, servers);
    return { url: '', token: '', ...prepared, claudeMcpFile };
  };
  sessions.revokeBridge = id => { bridge.revoke(id); sharedBrowsers.release(id); void workspaceMcpLaunches.release(id).catch(() => sessions.emit('service-error', new Error('Linked MCP runtime cleanup failed.'))); };
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
    if (session.chatInterface === 'chat') {
      if (session.switchingInterface || session.stopping || session.toolUpdating || session.process !== session.graphical || session.status !== 'running') throw new Error('Reconnect the graphical chat before attaching files.');
      if (session.agent === 'claude') return session.graphical.attach(verified);
      session.graphical.attachmentInfo ||= new Map();
      for (const file of verified) session.graphical.attachmentInfo.set(file, describeAttachment(file, await stat(file)));
      session.graphical.attachments = [...new Set([...session.graphical.attachments, ...verified])].slice(0, 100);
      for (const file of verified) session.graphical.previewPaths.add(await realpath(file));
      session.graphical.changed(); return { attached: verified, submitted: false };
    }
    sessions.input(id, attachmentText(verified, session.agent), { coordinator, submit: false });
    return { attached: verified, submitted: false };
  };
  const coordinator = await new Coordinator({
    accountContext: id => profiles.context(id, repo), verifyAccount: sessions.verifyAccount,
    verifyIdentity: id => id && id !== 'system' ? profiles.assertIdentity(id) : undefined,
    threadConfig: async profileId => {
      const global = await (await codexTools(profileId)).scopes.list(null);
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
        case 'open_chat': { if (args.agent === 'opencode' && args.effort != null) throw new Error('OpenCode uses native model variants. Omit effort.'); const session = await sessions.create(await sessionOptions({ ...args, name: taskTitle(args.name), effort: args.effort ? taskEffort(latestRequest, args.effort) : workerDefault(settings, args.agent), bypass: args.bypass ?? agentBypass(args.agent) })); focus(session.id); return session; }
        case 'read_chat': return sessions.read(args.id);
        case 'send_to_chat': return workers.send(args.id, args.text);
        case 'attach_files': return attach(args.id, args.paths, true);
        case 'focus_chat': return focus(args.id);
        case 'rename_chat': return sessions.rename(args.id, args.name);
        case 'interrupt_chat': return workers.interrupt(args.id);
        case 'list_workspace': return workspace.list(args);
        case 'read_workspace': return workspace.read(args.entityId, args.step);
        case 'workspace_activity': return workspace.activity(args.date);
        case 'update_workspace': return projects.serialize(() => workspace.update(args.entityId, args));
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
    createChat: async (options, request) => sessions.create(await sessionOptions({ ...options, name: taskTitle(options.name), effort: options.effort ? taskEffort(request, options.effort) : workerDefault(settings, options.agent), bypass: agentBypass(options.agent) })),
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
  sessions.on('graphical', event => broadcast('graphical', event));
  sessions.on('completion', completion => { if (settings.completionNotifications !== false) native({ type: 'completion-notification', ...completion, selected: selectedId === completion.sessionId }); });
  sessions.on('removed', ({ id }) => { if (activeInspection?.sessionId === id) activeInspection = null; broadcast('removed', { id }); });
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
      if (closing) throw Object.assign(new Error('Mr. Mik is shutting down.'), { status: 503 });
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error('Unexpected host'), { status: 403 });
      if (url.pathname === '/shared-browser') {
        if (request.method !== 'POST' || request.headers.origin) throw Object.assign(new Error('Not allowed'), { status: 403 });
        const record = sharedBrowsers.authenticate(String(request.headers.authorization || '').replace(/^Bearer /, ''));
        const data = await body(request, 256 * 1024);
        try { return json(response, 200, data.action === 'tools' ? await sharedBrowsers.tools(record) : data.action === 'call' ? await sharedBrowsers.call(record, data.name, data.args) : { error: 'Unknown browser operation.' }); }
        catch (error) { const safe = /^(The user controls|Wait for|This tool|Use an HTTP|Choose|Attach|The shared browser|Browser access)/.test(error.message); return json(response, 400, { error: safe ? error.message : 'The shared browser could not complete this action.' }); }
      }
      if (url.pathname === '/bridge') {
        if (request.method !== 'POST' || request.headers.origin) throw Object.assign(new Error('Not allowed'), { status: 403 });
        if (workspaceTransferBusy) throw Object.assign(new Error('Wait for the workspace transfer to finish.'), { status: 409 });
        const data = await body(request, 3 * 1024 * 1024);
        return json(response, 200, await bridge.call(String(request.headers.authorization || '').replace(/^Bearer /, ''), data.name, data.args));
      }
      if (url.pathname === '/health') return json(response, 200, { service: 'mrmik', version: appVersion });
      if (url.pathname.startsWith('/api/')) {
        authorize(request);
        const method = request.method;
        if ((workspaceTransferBusy || portable.importing) && method !== 'GET') throw Object.assign(new Error('Wait for the workspace transfer to finish before changing the Hub.'), { status: 409 });
        const inspectorRoute = /^\/api\/inspector\/([^/]+)$/.exec(url.pathname);
        if (inspectorRoute) {
          const session = sessions.get(inspectorRoute[1]), runtime = session.chatInterface === 'chat' && session.graphical;
          if (!runtime) throw new Error('Open the recorded result in a graphical chat first.');
          if (method === 'GET') { await runtime.ensureHistoryItem?.(url.searchParams.get('itemId')); return json(response, 200, inspectItem(runtime, url.searchParams.get('itemId'))); }
          if (method !== 'POST') throw Object.assign(new Error('Not allowed'), { status: 405 });
          const data = await body(request);
          if (data.action === 'hide') { if (activeInspection?.sessionId === session.id && activeInspection.itemId === data.itemId) activeInspection = null; return json(response, 200, { hidden: true }); }
          await runtime.ensureHistoryItem?.(data.itemId);
          if (data.action === 'file') return json(response, 200, await inspectFile(runtime, data));
          if (data.action === 'quote') { if (session.process !== runtime || session.status !== 'running' || session.switchingInterface || session.stopping || session.toolUpdating) throw new Error('Reconnect this chat before adding context.'); const result = quoteRecordedDiff(runtime, data); await sessions.persist(); return json(response, 200, result); }
          if (data.action !== 'show') throw new Error('Unknown inspector operation.');
          inspectItem(runtime, data.itemId); activeInspection = { sessionId: session.id, itemId: data.itemId }; sharedBrowsers.selectedId = null;
          show('workspace', { inspector: activeInspection, userInitiated: true }); return json(response, 200, { shown: true });
        }
        if (url.pathname === '/api/browser-settings') {
          const session = url.searchParams.get('sessionId') ? sessions.get(url.searchParams.get('sessionId')) : null;
          if (method === 'GET') return json(response, 200, browserSettings.read(session, url.searchParams.get('projectId') || session?.projectId));
          if (method === 'POST') {
            const data = await body(request);
            if (data.action === 'clear') {
              if (data.confirmed !== true) throw new Error('Confirm clearing this chat’s website data.');
              await sharedBrowsers.clearProfile(sharedBrowsers.get(data.sessionId));
              return json(response, 200, browserSettings.read(sessions.get(data.sessionId)));
            }
            return json(response, 200, await browserSettings.change(data));
          }
        }
        const browserRoute = /^\/api\/browser\/([^/]+)(?:\/(upload|download)\/?)?(?:\/([^/]+))?$/.exec(url.pathname);
        if (browserRoute) {
          const record = sharedBrowsers.get(browserRoute[1]);
          if (method === 'GET' && browserRoute[2] === 'download') {
            const file = await sharedBrowsers.download(record, browserRoute[3]);
            response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff' }); response.end(file.bytes); return;
          }
          if (method === 'POST' && browserRoute[2] === 'upload') {
            let length = 0; const chunks = []; for await (const chunk of request) { length += chunk.length; if (length > 16 * 1024 * 1024) throw new Error('Choose a file of 16 MB or less.'); chunks.push(chunk); }
            return json(response, 200, await sharedBrowsers.upload(record, decodeURIComponent(request.headers['x-file-name'] || 'file'), Buffer.concat(chunks)));
          }
          if (browserRoute[2]) throw Object.assign(new Error('Not allowed'), { status: 405 });
          if (method === 'GET') return json(response, 200, sharedBrowsers.state(record));
          if (method !== 'POST') throw Object.assign(new Error('Not allowed'), { status: 405 });
          const data = await body(request);
          if (data.action === 'annotate') { const runtime = sessions.get(record.id).graphical; const selection = await sharedBrowsers.selection(record); if (sessions.get(record.id).graphical !== runtime) throw new Error('The chat changed. Capture the selection again.'); return json(response, 200, runtime.composer.addBrowser(selection)); }
          if (data.action === 'show') { sharedBrowsers.selectedId = record.id; show('workspace', { browserSessionId: record.id, userInitiated: true }); return json(response, 200, { shown: true }); }
          if (data.action === 'hide') { sharedBrowsers.hide(record); return json(response, 200, { hidden: true }); }
          if (data.action === 'release-control') { sharedBrowsers.hide(record, false); return json(response, 200, { released: true }); }
          return json(response, 200, await sharedBrowsers.action(record, data));
        }
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
          const claude = sessionId && sessions.get(sessionId).agent === 'claude' && sessions.get(sessionId).chatInterface === 'chat';
          // The chat's explicit project wins. An unassigned chat follows the
          // workspace currently selected by the user when the image is pasted.
          const projectId = (sessionId ? sessions.get(sessionId).projectId : null) || settings.selectedProjectId || null;
          if (projectId) await projects.get(projectId);
          const chunks = []; let length = 0;
          for await (const chunk of request) { length += chunk.length; if (length > (claude ? CLAUDE_IMAGE_BYTES : MAX_IMAGE_BYTES)) throw Object.assign(new Error(claude ? 'Choose a Claude image of 4 MB or less.' : 'Choose an image smaller than 25 MB.'), { status: 413 }); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks);
          if (claude && !['.png', '.jpg', '.gif', '.webp'].includes(imageExtension(bytes))) throw new Error('Claude image attachments support PNG, JPEG, GIF and WebP.');
          const saved = await attachments.save(bytes, decodeURIComponent(request.headers['x-file-name'] || 'Screenshot'));
          if (projectId) await projects.assignResource({ kind: 'inbox', path: path.relative(repo, saved.path).replaceAll('\\', '/'), projectId });
          broadcast('workspace-changed', {});
          return json(response, 201, saved);
        }
        const data = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await body(request, url.pathname === '/api/files/markdown' ? 12 * 1024 * 1024 : url.pathname === '/api/cards/page' ? 3 * 1024 * 1024 : 256 * 1024) : {};
        if (cardMutation && url.pathname.startsWith('/api/workspace/')) throw Object.assign(new Error('Wait for the card or workspace change before transferring data.'), { status: 409 });
        if (method === 'GET' && url.pathname === '/api/bootstrap') {
          return json(response, 200, { repo, inspector: activeInspection, browserSessionId: sharedBrowsers.selectedId || null, projects: await projects.list(), contentBase: `${files.origin}/view/${files.repoGrant}`, agents: inventory(), sessions: sessions.list(), settings, selectedId, notices, coordinator: coordinator.state, voice: { configured: false, owner: voiceOwner }, voiceHistory, operations: [...coordinator.operations.values(), ...quick.operations.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-30) });
        }
        if (method === 'GET' && url.pathname === '/api/projects') return json(response, 200, await projects.list());
        const projectIconRoute = /^\/api\/projects\/([\w-]+)\/icon$/.exec(url.pathname);
        if (method === 'GET' && projectIconRoute) return json(response, 200, await workspaceIcon(projects, projectIconRoute[1]));
        if (method === 'POST' && projectIconRoute) return json(response, 200, await saveWorkspaceIcon(projects, projectIconRoute[1], data.dataUrl));
        const iconGenerationRoute = /^\/api\/projects\/([\w-]+)\/icon-generation$/.exec(url.pathname);
        if (method === 'POST' && iconGenerationRoute) {
          const project = await projects.get(iconGenerationRoute[1]);
          if (data.action === 'context') {
            const cards = (await registry()).entities.filter(item => item.projectId === project.id).slice(0, 6).map(item => ({ title: String(item.title || '').slice(0, 160), description: String(item.description || '').slice(0, 250) }));
            return json(response, 200, { description: `An icon for ${project.name}. Linked projects: ${project.repositories.map(item => item.name).join(', ') || 'none'}. ${cards.length ? 'Workspace topics: ' + cards.map(item => item.title + (item.description ? ': ' + item.description : '')).join('; ') + '. ' : ''}Simple recognizable shapes, no text.` });
          }
          if (data.action === 'prepare') {
            if (!['codex', 'claude'].includes(data.agent)) throw new Error('Choose Codex or Claude.');
            let prepared;
            try {
              prepared = await sessions.create(await sessionOptions({ agent: data.agent, accountProfileId: data.accountProfileId, projectId: project.id, repositoryId: 'hub', chatInterface: 'chat', name: 'Workspace icon', bypass: false, codexPermissions: 'ask', effort: 'low' }));
              const runtime = sessions.get(prepared.id).graphical;
              return json(response, 201, { sessionId: prepared.id, runtimeId: runtime.runtimeId, models: await runtime.models() });
            } catch (error) { if (prepared) await sessions.remove(prepared.id); throw error; }
          }
          const session = sessions.get(data.sessionId), runtime = session.graphical;
          if (session.projectId !== project.id || session.chatInterface !== 'chat' || !runtime || session.process !== runtime || data.runtimeId !== runtime.runtimeId) throw new Error('The icon chat changed. Reopen its configuration.');
          if (data.action === 'status') {
            const snapshot = runtime.snapshot();
            return json(response, 200, { working: !!snapshot.working, images: workspaceIconOutputs(snapshot), requests: snapshot.requests?.filter(request => !request.responded).length || 0, error: snapshot.error || '', text: (snapshot.items || []).filter(item => item.type === 'agentMessage').map(item => item.text || '').join('\n').slice(-3000) });
          }
          if (data.action === 'generate') {
            const prompt = workspaceIconPrompt(project, data.description);
            if (!runtime.idle() || session.activity === 'working' || session.stopping || session.toolUpdating || session.permissionApplying) throw new Error('Wait for the current icon request to finish.');
            const models = await runtime.models(), model = models.find(item => (item.model || item.value) === data.model);
            if (!model) throw new Error('Choose an available model.');
            if (!runtime.idle() || session.process !== runtime) throw new Error('The icon chat changed.');
            if (session.agent === 'claude') await runtime.configure(data.model);
            else { runtime.model = data.model; session.graphicalModel = data.model; session.effort = model.supportedReasoningEfforts?.some(item => item.reasoningEffort === 'low') ? 'low' : model.defaultReasoningEffort; runtime.changed(); }
            if (session.process !== runtime || session.stopping || session.toolUpdating) throw new Error('The icon chat changed before sending.');
            session.lastInputAt = new Date().toISOString();
            const result = await runtime.submit(prompt); sessions.changed(session); await sessions.persist();
            return json(response, 200, result);
          }
          throw new Error('Unknown icon generation action.');
        }
        if (method === 'POST' && url.pathname === '/api/workspace/export/preview') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before exporting.'); await coordinator.saves; return json(response, 200, await projects.serialize(() => portable.reviewExport(data.folder))); }
        if (method === 'POST' && url.pathname === '/api/workspace/export') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before exporting.'); await coordinator.saves; return json(response, 201, await projects.serialize(() => portable.exportTo(data.folder, { chats: data.chats, attachmentToken: data.attachmentToken, approveAttachments: data.approveAttachments === true, includeMedia: data.includeMedia === true, approveMedia: data.approveMedia === true, skipNative: data.skipNative }))); }
        if (method === 'POST' && url.pathname === '/api/workspace/import/preview') return json(response, 200, await portable.preview(data.path));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/export') return json(response, 201, await projects.serialize(() => snapshots.exportTo(data.folder, data.projectId)));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/preview') return json(response, 200, await snapshots.preview(data.folder));
        if (method === 'POST' && url.pathname === '/api/workspace/snapshot/update/preview') return json(response, 200, await snapshots.updatePreview(data.folder, data.projectId));
        if (method === 'POST' && ['/api/workspace/snapshot/import', '/api/workspace/snapshot/update'].includes(url.pathname)) {
          if (coordinator.operationPromises.size || sessions.active().length) throw new Error('Close worker chats and wait for Mik before updating or importing a workspace snapshot.');
          return await runWorkspaceTransfer(async () => {
            const imported = url.pathname.endsWith('/import') ? await snapshots.importFrom(data.folder, data) : await snapshots.update(data.folder, data.projectId);
            broadcast('workspace-changed', {}); broadcast('projects-changed', {});
            return json(response, 200, imported);
          });
        }
        if (method === 'POST' && url.pathname === '/api/workspace/import') {
          if (coordinator.operationPromises.size) throw new Error('Wait for Mak or stop its request before importing.');
          return await runWorkspaceTransfer(async () => {
            await coordinator.saves; await coordinator.disconnect();
            const imported = await projects.serialize(() => portable.importFrom(data.path, { relinks: data.relinks, replaceNative: data.replaceNative, replaceHub: data.replaceHub, replaceSkills: data.replaceSkills, restoreSettings: data.restoreSettings === true, skipNative: data.skipNative, reviewHash: data.reviewHash }));
            try {
              if (imported.restoredSettings) {
                const restored = { ...imported.restoredSettings };
                if (restored.defaultAgent && !inventory().some(agent => agent.id === restored.defaultAgent && agent.available)) delete restored.defaultAgent;
                Object.assign(settings, restored); await saveSettings(); broadcast('settings', { settings });
              }
              broadcast('workspace-changed', {}); broadcast('projects-changed', {});
              await coordinator.init(); coordinator.threads.clear(); coordinator.usedThreads.clear();
            } catch (error) { throw new Error(`Workspace import was committed, but refreshing the application failed. Do not repeat the import without reviewing its result. Backup: ${imported.backup}. ${error.message}`); }
            return json(response, 200, imported);
          });
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
          const session = await sessions.create(await sessionOptions({ agent, name, projectId: project?.id || null, cardId: card?.id || null, repositoryId: linked?.id || 'hub', cwd: project ? undefined : repo, effort: workerDefault(settings, agent), bypass: agentBypass(agent) }));
          focus(session.id);
          return json(response, 201, session);
        }
        if (method === 'POST' && url.pathname === '/api/chats/compose') {
          if (data.projectId) await projects.get(data.projectId);
          if (data.cardId && !(await registry()).entities.some(item => item.id === data.cardId && item.projectId === data.projectId)) throw new Error('Card is not associated with this project.');
          show('chats', { compose: { projectId: data.projectId || null, cardId: data.cardId || null } });
          return json(response, 200, { opened: true });
        }
        if (method === 'GET' && url.pathname === '/api/codex/scopes') return json(response, 200, await (await codexTools(url.searchParams.get('profileId'))).scopes.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'GET' && url.pathname === '/api/codex/effective') return json(response, 200, await effectiveCodex(await projects.root(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')), (await profiles.context(url.searchParams.get('profileId') || 'system')).env));
        if (method === 'POST' && url.pathname === '/api/codex/scopes') return json(response, 200, await (await codexTools(data.profileId)).scopes.set(data.projectId, data));
        if (method === 'GET' && url.pathname === '/api/codex/mcp-managed') return json(response, 200, await (await codexTools(url.searchParams.get('profileId'))).editor.list(url.searchParams.get('scope'), url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'POST' && url.pathname === '/api/codex/mcp-managed') return json(response, 200, await (await codexTools(data.profileId)).editor.change(data));
        if (method === 'GET' && url.pathname === '/api/claude/mcp-managed') return json(response, 200, await (await claudeTools(url.searchParams.get('profileId'))).editor.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId'), url.searchParams.get('scope') || 'local'));
        if (method === 'POST' && url.pathname === '/api/claude/mcp-managed') return json(response, 200, await (await claudeTools(data.profileId)).editor.change(data));
        if (method === 'GET' && url.pathname === '/api/claude/scopes') return json(response, 200, await (await claudeTools(url.searchParams.get('profileId'))).settings.list(url.searchParams.get('projectId'), url.searchParams.get('repositoryId')));
        if (method === 'POST' && url.pathname === '/api/claude/scopes') return json(response, 200, await (await claudeTools(data.profileId)).settings.set(data.projectId, data));
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
        if (method === 'POST' && url.pathname === '/api/cards/assign') return json(response, 200, await projects.assignCard(data.id, data.projectId, data.repositoryId));
        if (method === 'POST' && url.pathname === '/api/cards/repository') return json(response, 200, await projects.assignCardRepository(data.id, data.repositoryId));
        if (method === 'POST' && url.pathname === '/api/cards') return json(response, 201, await projects.createCard(data));
        if (method === 'POST' && url.pathname === '/api/cards/note') return json(response, 201, await projects.addCardNote(data));
        if (method === 'POST' && url.pathname === '/api/cards/page') return json(response, 201, await projects.addCardPage(data));
        if (method === 'PUT' && url.pathname === '/api/cards/page') return json(response, 200, await projects.updateCardPage(data));
        if (method === 'POST' && url.pathname === '/api/cards/asset') return json(response, 201, await projects.importCardAsset(data));
        if (method === 'POST' && url.pathname === '/api/cards/artifact') return json(response, 201, await projects.linkArtifact(data));
        if (method === 'GET' && url.pathname === '/api/cards/artifact/preview') return json(response, 200, await files.preview(await projects.artifactLocation(url.searchParams.get('projectId'), url.searchParams.get('id'), url.searchParams.get('path'), url.searchParams.get('repositoryId'), url.searchParams.get('scope'))));
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
        if (method === 'GET' && url.pathname === '/api/accounts/claude-profiles') return json(response, 200, url.searchParams.get('status') === 'false' ? await claudeProfiles.list() : await accounts.claudeInventory());
        if (method === 'POST' && url.pathname === '/api/accounts/claude-profiles') {
          if (data.action === 'create') { const result = await claudeProfiles.create(data.label, data.directory); broadcast('accounts-changed', {}); return json(response, 201, result); }
          if (profileBlocked('claude', data.id) || accounts.terminalOpen('claude', data.id)) throw new Error('Close this Claude profile’s chats and finish its account action first.');
          const result = data.action === 'rename' ? await claudeProfiles.rename(data.id, data.label) : data.action === 'remove' ? await claudeProfiles.remove(data.id) : null;
          if (!result) throw new Error('Unknown Claude profile action.'); broadcast('accounts-changed', {}); return json(response, 200, result);
        }
        if (method === 'GET' && url.pathname === '/api/accounts/profiles') return json(response, 200, (url.searchParams.get('status') === 'false' ? await profiles.list() : await accounts.profileInventory()).filter(row => !row.system));
        if (method === 'POST' && url.pathname === '/api/accounts/profiles') {
          if (data.action === 'verify') {
            if (typeof data.identityRevision !== 'string' || !/^[a-f0-9]{64}$/.test(data.identityRevision)) throw new Error('Refresh Accounts and review its identity before verifying.');
            if (profileBlocked('codex', data.id) || accounts.terminalOpen('codex', data.id) || await profiles.accountAction()) throw new Error('Close this profile’s chats and finish account actions before verifying its identity.');
            await codexCliVerifier.invalidate(); await codexPreparation.cancel(); await sessions.codexWorkers.invalidate(data.id);
            const result = await profiles.bindIdentity(data.id, { existing: true, expected: data.identityRevision }); broadcast('accounts-changed', {}); return json(response, 200, result);
          }
          if (data.action === 'rename') { const result = await profiles.rename(data.id, data.label); broadcast('accounts-changed', {}); return json(response, 200, result); }
          if (data.action === 'remove') { if (typeof data.id !== 'string' || data.id === 'system' || !(await profiles.list()).some(item => item.id === data.id)) throw new Error('Choose an existing account profile.'); await codexCliVerifier.invalidate(); await codexPreparation.cancel(); await sessions.codexWorkers.invalidate(data.id); if (profileBlocked('codex', data.id) || accounts.terminalOpen('codex', data.id) || (await profiles.accountAction())?.profileId === data.id) throw new Error('Close this profile’s chats and account terminal before removing its association.'); if ((coordinator.runtimeProfileId || 'system') === data.id) await coordinator.disconnect(); const result = await profiles.remove(data.id); broadcast('accounts-changed', {}); return json(response, 200, result); }
          if (data.action !== 'create') throw new Error('Unknown account profile action.');
          return json(response, 201, await profiles.create(data.label, { copySettings: data.copySettings === true }));
        }
        if (method === 'GET' && url.pathname === '/api/accounts/limits') return json(response, 200, await accountLimits(sessions, url.searchParams.get('agent'), url.searchParams.get('profileId'), accountLimitReader));
        if (method === 'GET' && url.pathname === '/api/accounts') return json(response, 200, await accounts.inventory(url.searchParams.get('agent')));
        if (method === 'POST' && url.pathname === '/api/accounts/plan') { if (data.agent === 'codex') sessions.requireAccount(data.profileId); return json(response, 200, data.agent === 'claude' ? await accounts.claudePlan(data.profileId, data.action) : data.agent === 'codex' && data.profileId ? await accounts.profilePlan(data.profileId, data.action, { disconnect: data.disconnect === true }) : accounts.plan(data.agent, data.action, data.provider)); }
        if (method === 'POST' && url.pathname === '/api/accounts/confirm') { const result = await accounts.confirm(data.token); accountLimitReader.invalidate(); broadcast('accounts-changed', {}); return json(response, 200, result); }
        if (method === 'GET' && url.pathname === '/api/mcp') {
          const selection = { projectId: url.searchParams.get('projectId'), repositoryId: url.searchParams.get('repositoryId') };
          const selectedTools = await codexTools(url.searchParams.get('profileId'));
          const result = await (url.searchParams.get('claudeProfileId') ? await claudeInventory(url.searchParams.get('claudeProfileId'), selection.projectId, selection.repositoryId) : await projectMcp(selection.projectId, selection.repositoryId, url.searchParams.get('profileId') || 'system')).list();
          return json(response, 200, { ...result, recoveryCandidates: await selectedTools.recovery.candidates(selection, result) });
        }
        if (method === 'POST' && url.pathname === '/api/mcp/recovery/preview') return json(response, 200, await (await codexTools(data.profileId)).recovery.preview(data));
        if (method === 'POST' && url.pathname === '/api/mcp/preflight') return json(response, 200, await mcpPreflight(data.folders, mcpOptions));
        if (method === 'POST' && url.pathname === '/api/mcp/recovery/apply') return json(response, 200, await (await codexTools(data.profileId)).recovery.apply(data.token));
        if (method === 'POST' && url.pathname === '/api/mcp/recovery/undo') return json(response, 200, await (await codexTools(data.profileId)).recovery.undo(data.token));
        if (method === 'POST' && url.pathname === '/api/mcp/check') return json(response, 200, await (data.claudeProfileId ? await claudeInventory(data.claudeProfileId, data.projectId, data.repositoryId) : await projectMcp(data.projectId, data.repositoryId, data.profileId || 'system')).check(data.id));
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
          // Validate before changing any in-memory preference. Changing these
          // settings never refreshes or restarts an existing worker process.
          if (data.managedBrowser !== undefined && !browserChoices.includes(data.managedBrowser)) throw new Error('Choose Off, Edge or Chrome for the Mr. Mik browser.');
          if (data.managedBrowserHeadless !== undefined && typeof data.managedBrowserHeadless !== 'boolean') throw new Error('Invalid browser window preference.');
          if (data.managedBrowserProject !== undefined) {
            const patch = data.managedBrowserProject;
            if (!patch || typeof patch.projectId !== 'string' || !(patch.choice === null || browserChoices.includes(patch.choice))) throw new Error('Invalid project browser preference.');
            await projects.get(patch.projectId);
          }
          if (data.defaultWorkerEffort !== undefined && !defaultWorkerEfforts.includes(data.defaultWorkerEffort) || data.defaultClaudeWorkerEffort !== undefined && !claudeEfforts.includes(data.defaultClaudeWorkerEffort) || data.coordinatorEffort !== undefined && !defaultWorkerEfforts.includes(data.coordinatorEffort)) throw new Error('Invalid reasoning level.');
          if (data.defaultClaudePermissions !== undefined && !['ask', 'bypass'].includes(data.defaultClaudePermissions)) throw new Error('Invalid Claude default permissions.');
          if (data.defaultCodexPermissions != null) codexPermissionMode(data.defaultCodexPermissions);
          if (data.completionNotifications !== undefined && typeof data.completionNotifications !== 'boolean') throw new Error('Invalid notification preference.');
          if (data.chatWidthPercent !== undefined && (!Number.isInteger(data.chatWidthPercent) || data.chatWidthPercent < 20 || data.chatWidthPercent > 65)) throw new Error('Choose a chat window percentage between 20 and 65.');
          const chatShortcuts = data.chatShortcuts === undefined ? null : validateChatShortcuts(data.chatShortcuts);
          if (data.selectedProjectId !== undefined) { if (data.selectedProjectId) await projects.get(data.selectedProjectId); settings.selectedProjectId = data.selectedProjectId || null; }
          if (chatShortcuts) settings.chatShortcuts = chatShortcuts;
          if (inventory().some(item => item.id === data.defaultAgent)) settings.defaultAgent = data.defaultAgent;
          if (typeof data.defaultBypass === 'boolean') settings.defaultBypass = data.defaultBypass;
          if (data.defaultClaudePermissions !== undefined) settings.defaultClaudePermissions = data.defaultClaudePermissions;
          if (data.defaultCodexPermissions != null) settings.defaultCodexPermissions = codexPermissionMode(data.defaultCodexPermissions);
          if (defaultWorkerEfforts.includes(data.defaultWorkerEffort)) settings.defaultWorkerEffort = data.defaultWorkerEffort;
          if (claudeEfforts.includes(data.defaultClaudeWorkerEffort)) settings.defaultClaudeWorkerEffort = data.defaultClaudeWorkerEffort;
          if (Number.isInteger(data.terminalFontSize) && data.terminalFontSize >= 10 && data.terminalFontSize <= 24) settings.terminalFontSize = data.terminalFontSize;
          if (typeof data.completionNotifications === 'boolean') settings.completionNotifications = data.completionNotifications;
          if (data.chatWidthPercent !== undefined) settings.chatWidthPercent = data.chatWidthPercent;
          if (data.managedBrowser !== undefined) await browserSettings.change({ scope: 'global', choice: data.managedBrowser });
          if (typeof data.managedBrowserHeadless === 'boolean') settings.managedBrowserHeadless = data.managedBrowserHeadless;
          if (data.managedBrowserProject !== undefined) await browserSettings.change({ scope: 'project', projectId: data.managedBrowserProject.projectId, choice: data.managedBrowserProject.choice });
          if (['focus', 'original'].includes(data.terminalAppearance)) settings.terminalAppearance = data.terminalAppearance;
          if (['rose', 'violet', 'blue', 'teal'].includes(data.accentTheme)) settings.accentTheme = data.accentTheme;
          if (defaultWorkerEfforts.includes(data.coordinatorEffort)) settings.coordinatorEffort = data.coordinatorEffort;
          await saveSettings(); broadcast('settings', { settings });
          if (data.chatWidthPercent !== undefined) native({ type: 'window', action: 'layout', window: 'workspace', chatWidthPercent: settings.chatWidthPercent });
          return json(response, 200, settings);
        }
        if (method === 'POST' && url.pathname === '/api/codexpreparation') { codexPreparation.request(data.cancel ? null : { agent: data.agent, chatInterface: data.chatInterface, accountProfileId: data.accountProfileId, projectId: data.projectId, repositoryId: data.repositoryId, cardId: data.cardId, cwd: data.cwd, codexPermissions: data.codexPermissions }); return json(response, 202, { scheduled: true }); }
        if (method === 'POST' && url.pathname === '/api/sessions') { const session = await sessions.create(await sessionOptions({ ...data, codexPermissions: data.codexPermissions ?? (typeof data.bypass === "boolean" ? codexPermissionMode(undefined, data.bypass) : undefined), effort: data.effort ?? workerDefault(settings, data.agent), bypass: data.bypass ?? agentBypass(data.agent) })); focus(session.id);
          if (session.agent === 'codex' && session.chatInterface === 'chat') {
            const item = sessions.get(session.id);
            void Promise.resolve(item.startupPromise).then(() => {
              if (closing || selectedId !== item.id || !item.graphical?.initialized) return;
              settings.codexLastGraphicalContext = { agent: 'codex', chatInterface: 'chat', accountProfileId: item.accountProfileId, projectId: item.projectId || null, repositoryId: item.repositoryId || 'hub', cwd: item.cwd, codexPermissions: item.codexPermissions };
              scheduleSettings();
            }).catch(() => {});
          } else if (session.chatInterface !== 'chat') { settings.codexLastGraphicalContext = null; scheduleSettings(); }
          return json(response, 201, session); }
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
          if (method === 'POST' && action === 'claudepermissions') { const session = sessions.get(id); if (session.agent !== 'claude' || session.chatInterface === 'chat') throw new Error('Choose a Claude CLI chat.'); return json(response, 200, await claudeCliPermissions.chooseMode(id, data.permissionMode)); }
          if (method === 'POST' && action === 'contextedit') { const session = sessions.get(id), runtime = session.graphical; if (!runtime || session.process !== runtime || session.status !== 'running') throw new Error('Reconnect the graphical chat first.'); return json(response, 200, runtime.composer.editBrowser(data.id, data.text)); }
          if (method === 'POST' && action === 'results') {
            const session = sessions.get(id), runtime = session.graphical;
            if (!runtime || !['codex', 'claude'].includes(session.agent) || session.chatInterface !== 'chat') throw new Error('Open a graphical chat first.');
            if (data.runtimeId && data.runtimeId !== runtime.runtimeId) throw new Error('The conversation changed. Refresh outputs.');
            if (!['open','verify'].includes(data.action)) return json(response, 200, await conversationResults(runtime, data));
            await runtime.ensureHistoryItem?.(data.itemId);
            const item = runtime.items.get(data.itemId) || runtime.historyItems.get(data.itemId), result = item && messageResults(item).find(value => value.index === data.index && value.revision === data.revision);
            if (data.action === 'verify') { if (!result) throw new Error('This output changed. Refresh outputs.'); return json(response, 200, { verified: true, ...(result.resourceIndex != null ? {resource:item.resources[result.resourceIndex]} : {}) }); }
            if (!result || !['code', 'message'].includes(result.type)) throw new Error('This output changed. Refresh outputs.');
            const preview = result.type === 'code' ? await chatBlockPreview(session, runtime, { ...result, kind: 'code', runtimeId: runtime.runtimeId }) : { kind: 'rich', blockKind: 'code', language: 'markdown', name: 'Table response', path: '', identity: result.revision + ':' + session.id + ':' + item.id, text: item.text, size: Buffer.byteLength(item.text), source: { sessionId: session.id, itemId: item.id } };
            if (session.graphical !== runtime) throw new Error('The conversation changed. Refresh outputs.');
            preview.interactiveUrl = files.interactive.publish(preview, files.origin);
            show('workspace', { preview, userInitiated: true }); return json(response, 200, { opened: preview.name });
          }
          if (method === 'POST' && action === 'previewblock') {
            const session = sessions.get(id), runtime = session.graphical;
            const { disk, workspaceOnly, ...preview } = await chatBlockPreview(session, runtime, data, repo);
            if (session.graphical !== runtime) throw new Error('The conversation changed. Reopen this block.');
            if (workspaceOnly) return json(response, 200, { workspaceOnly: true });
            if (data.bundle === true) { if (!/^(html|htm)$/i.test(preview.language || '')) throw new Error('Choose an HTML block.'); preview.originalHtml = preview.text; preview.text = await bundleHtml(preview.text, session.cwd); preview.identity += '-bundle-' + createHash('sha256').update(preview.text).digest('hex').slice(0, 16); preview.size = Buffer.byteLength(preview.text); }
            if (session.graphical !== runtime) throw new Error('The conversation changed. Reopen this block.');
            preview.interactiveUrl = files.interactive.publish(disk ? { ...preview, disk } : preview, files.origin);
            if (data.inline === true) { if (!preview.interactiveUrl) throw new Error('Choose a renderable HTML block.'); return json(response, 200, { interactiveUrl: preview.interactiveUrl, identity: preview.identity }); }
            show('workspace', { preview, userInitiated: true }); return json(response, 200, { opened: preview.name, identity: preview.identity });
          }
          if (method === 'POST' && action === 'output') {
            const session = sessions.get(id), runtime = session.graphical;
            if (data.action === 'open-card') {
              const card = (await registry()).entities.find(card => card.id === data.cardId && (card.projectId || null) === (session.projectId || null));
              if (!card) throw new Error('This card is no longer available to the project.');
              settings.selectedProjectId = session.projectId || null; scheduleSettings(); broadcast('settings', { settings });
              show('workspace', { route: `/${encodeURIComponent(card.id)}` }); return json(response, 200, { opened: card.id });
            }
            const scopedSession = { id: session.id, agent: session.agent, nativeId: session.nativeId, chatInterface: session.chatInterface, projectId: session.projectId, repositoryId: session.repositoryId, cwd: session.cwd };
            const assertCurrent = () => { if (session.graphical !== runtime || session.cwd !== scopedSession.cwd || session.projectId !== scopedSession.projectId || session.repositoryId !== scopedSession.repositoryId) throw new Error('The conversation changed. Reopen this output.'); };
            const output = await resolveChatCardOutput({ repo, projects, session: scopedSession, runtime, input: data });
            assertCurrent();
            if (data.action === 'describe') {
              const cards = (await registry()).entities.filter(card => (card.projectId || null) === (session.projectId || null) && card.status !== 'archived').map(card => ({ id: card.id, title: card.title }));
              return json(response, 200, { name: output.name, mode: output.mode, revision: output.revision, runtimeId: runtime.runtimeId, cards, cardId: session.cardId || null });
            }
            if (data.action === 'open' && output.actual) { const preview = await files.preview(output.actual); preview.source = { sessionId: session.id, itemId: data.itemId }; preview.viewState = previewViewState(data.viewState); show('workspace', { preview, userInitiated: true }); return json(response, 200, { opened: output.name }); }
            if (data.action === 'save') {
              if (data.runtimeId !== runtime.runtimeId) throw new Error('The conversation changed. Reopen this output.');
              return json(response, 201, await changeCards(() => saveChatCardOutput({ projects, session: scopedSession, output, input: data, assertCurrent })));
            }
            throw new Error('Choose an output action.');
          }
          if (method === 'GET' && action === 'chatoutput') {
            const runtime = sessions.get(id).graphical, itemId = url.searchParams.get('item');
            await runtime?.ensureHistoryItem?.(itemId);
            if (!runtime || !runtime.items.has(itemId) && !runtime.historyItems.has(itemId)) throw new Error('This output is no longer in the displayed history. Reload that history page.');
            return json(response, 200, { text: runtime.outputs.get(itemId) || '' });
          }
          if ((method === 'GET' && ['chatasset', 'chatfile', 'chatimage', 'chatresult'].includes(action)) || (method === 'POST' && action === 'chatfile')) {
            const session = sessions.get(id), runtime = session.graphical, itemId = url.searchParams.get('item');
            if (itemId && itemId !== 'draft') await runtime?.ensureHistoryItem?.(itemId, action === 'chatresult' && !runtime?.resultAssets.get(itemId));
            const item = runtime?.items.get(itemId) || runtime?.historyItems.get(itemId);
            if (url.searchParams.has('resultRevision') && (url.searchParams.get('runtimeId') !== runtime?.runtimeId || !item || !messageResults(item).some(result => result.revision === url.searchParams.get('resultRevision') && (action !== 'chatresult' || result.resourceIndex === Number(url.searchParams.get('resource')))))) throw new Error('This output changed. Refresh outputs.');
            const resourceIndex = Number(url.searchParams.get('resource'));
            const resultAsset = action === 'chatresult' && item && url.searchParams.has('resource') && Number.isInteger(resourceIndex) && resourceIndex >= 0 ? runtime?.resultAssets.get(itemId)?.[resourceIndex] : null;
            const resultPreview = action === 'chatresult' && url.searchParams.get('preview') === 'true';
            if (action === 'chatresult') {
              if (session.chatInterface !== 'chat' || !resultAsset || ['link', 'unsupported'].includes(resultAsset.kind)) throw new Error('This tool result is unavailable. Reload its history or ask the tool to save it to a file.');
              if (!resultAsset.path) {
                const { bytes, mimeType } = resultBytes(resultAsset, resultPreview);
                return json(response, 200, { name: resultAsset.name, url: `data:${mimeType};base64,${bytes.toString('base64')}` });
              }
              if (resultPreview) resultBytes({ ...resultAsset, data: '' }, true);
            }
            const index = Number(url.searchParams.get('attachment'));
            const reference = action === 'chatresult' ? resultAsset?.path : action === 'chatimage' ? url.searchParams.get('href') : url.searchParams.has('attachment') && Number.isInteger(index) && index >= 0 ? itemId === 'draft' ? runtime?.attachments[index] : url.searchParams.get('kind') === 'change' ? item?.changes?.[index]?.path : item?.attachments?.[index]?.path : item?.path;
            if (session.chatInterface !== 'chat' || !runtime || typeof reference !== 'string' || !reference || reference.length > 8192) throw new Error('No supported file is associated with this item.');
            if (url.searchParams.has('expectedPath') && url.searchParams.get('expectedPath') !== reference) throw new Error('The attachment list changed. Inspect the reference again.');
            const requested = action === 'chatimage' ? resolveChatFileLink(session.cwd, reference).file : reference;
            if (!['chatfile', 'chatresult'].includes(action) && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(requested)) throw new Error('No supported image is associated with this item.');
            const actual = await resolveConversationMedia(repo, stateDir, session.agent, session.nativeId, path.resolve(session.cwd, requested)) || await realpath(path.resolve(session.cwd, requested)).catch(error => { if (error.code === 'ENOENT') throw new Error('This local reference is no longer available. Attach an existing file to continue.'); throw error; }), account = await sessions.accountContext(session);
            const roots = [repo, session.cwd, ...[account?.privateHome, account?.sharedHome].filter(Boolean).map(home => path.join(home, 'generated_images'))];
            if (session.projectId && session.repositoryId === 'hub') {
              const workspace = await projects.get(session.projectId).catch(() => null);
              roots.push(...(workspace?.repositories || []).filter(link => link.available).map(link => link.repositoryPath));
            }
            // Compare canonical paths on both sides: profiles and linked folders may be junctions.
            const canonicalRoots = (await Promise.all(roots.map(root => realpath(root).catch(() => null)))).filter(Boolean);
            const descriptor = itemId === 'draft' ? runtime.attachmentDetails?.[index] : item?.attachments?.[index];
            const explicitAttachment = ['chatasset', 'chatfile'].includes(action) && url.searchParams.has('attachment') && !url.searchParams.has('kind') && Number.isInteger(index) && index >= 0 && (itemId === 'draft' || item?.type === 'userMessage') && (!descriptor?.resolvedPath || descriptor.resolvedPath === actual);
            if ((!canonicalRoots.some(root => within(root, actual)) && !runtime.previewPaths.has(actual) && !explicitAttachment) || /(?:^|[\\/])(?:\.env|auth\.json|credentials)(?:[\\/.]|$)/i.test(actual)) throw new Error('This file is outside the chat preview locations. Attach it explicitly to inspect it.');
            const info = await stat(actual), inputPreview = action === 'chatfile' && url.searchParams.get('preview') === 'true';
            const extension = path.extname(actual).slice(1).toLowerCase(), raster = /^(png|jpe?g|gif|webp|bmp)$/.test(extension);
            const verifyImage = async () => {
              if (session.agent === 'claude' && descriptor?.sha256 && (info.size > 10 * 1024 * 1024 || createHash('sha256').update(await readFile(actual)).digest('hex') !== descriptor.sha256)) throw new Error('This image changed since it was attached. Its original preview is unavailable.');
            };
            if (method === 'POST') {
              const assertAttachment = () => {
                const latest = itemId === 'draft' ? runtime.attachments[index] : (runtime.items.get(itemId) || runtime.historyItems.get(itemId))?.attachments?.[index]?.path;
                if (!explicitAttachment || !url.searchParams.has('expectedPath') || session.graphical !== runtime || latest !== reference) throw new Error('Choose an attachment from this conversation.');
              };
              assertAttachment();
              if (data.action === 'reveal') { native({ type: 'reveal', path: actual }); return json(response, 200, { requested: true }); }
              if (data.action === 'ide' && info.isFile() && isDevelopmentFile(actual)) return json(response, 200, await openIde(actual));
              if (data.action !== 'workspace' || !info.isFile()) throw new Error('Choose a supported attachment action.');
              if (raster) await verifyImage();
              const preview = await files.preview(actual, info);
              assertAttachment();
              preview.source = { sessionId: session.id, itemId };
              preview.viewState = previewViewState(data.viewState);
              show('workspace', { preview, userInitiated: true });
              return json(response, 200, { opened: preview.name });
            }
            const metadata = inputPreview ? await attachmentPreview(actual, info, runtime.attachmentInfo?.get(reference) || descriptor) : null;
            if (metadata && (metadata.kind === 'folder' || metadata.kind === 'text' || info.size > 10 * 1024 * 1024)) return json(response, 200, metadata);
            if (!info.isFile()) throw new Error('This is a folder reference, not a downloadable file.');
            if (info.size > 10 * 1024 * 1024) throw new Error('Chat previews and downloads support files up to 10 MB.');
            runtime.previewPaths.add(actual); sessions.dirty = true;
            if (inputPreview && /\.pdf$/i.test(actual)) return json(response, 200, { ...metadata, kind: 'document', url: files.singleFileUrl(actual) });
            if (inputPreview) {
              if (!raster) return json(response, 200, { ...metadata, message: metadata.message || 'No inline preview is available for this file type.' });
              await verifyImage();
              return json(response, 200, { ...metadata, kind: 'image', url: files.singleFileUrl(actual, info) });
            }
            if ((action === 'chatasset' || action === 'chatimage') && raster && url.searchParams.get('stream') === 'true') {
              await verifyImage();
              return json(response, 200, { name: path.basename(actual), identity: `${actual}:${info.mtimeMs}:${info.size}`, url: files.singleFileUrl(actual, info) });
            }
            const bytes = await readFile(actual);
            if (session.agent === 'claude' && descriptor?.sha256 && createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('This image changed since it was attached. Its original preview is unavailable.');
            return json(response, 200, { identity: `${actual}:${info.mtimeMs}:${info.size}`, name: path.basename(actual), url: `data:${action === 'chatresult' ? resultPreview ? resultAsset.mimeType : 'application/octet-stream' : action === 'chatfile' ? 'application/octet-stream' : `image/${extension === 'jpg' ? 'jpeg' : extension}`};base64,${bytes.toString('base64')}` });
          }
          if (method === 'POST' && action === 'interface') return json(response, 200, await sessions.setInterface(id, data.chatInterface));
          if (action === 'chat') {
            const session = sessions.get(id), runtime = session.graphical;
            if (session.chatInterface !== 'chat' || !runtime) throw new Error('Reconnect this graphical chat first.');
            if (method === 'GET') return json(response, 200, url.searchParams.has('since') ? graphicalSync(runtime, url.searchParams.get('since'), url.searchParams.get('runtimeId')) : runtime.snapshot());
            if (['composer-add', 'open-file'].includes(data.action)) await runtime.ensureHistoryItem?.(data.context?.itemId || data.itemId);
            if (session.agent === 'claude') {
              if (!claudeGraphicalActions.has(data.action)) throw new Error('This operation is not available in Claude graphical preview.');
              if (['steer', 'enqueue', 'queue-edit', 'queue-cancel', 'queue-pause', 'send', 'answer', 'configure', 'set-permissions', 'acknowledge-uncertain', 'interrupt', 'detach-attachment', 'history', 'search-history', 'search-open', 'skills', 'composer-add', 'composer-remove', 'composer-source', 'usage', 'compact', 'compact-dismiss', 'agent-read', 'prepare-review'].includes(data.action) && data.runtimeId !== runtime.runtimeId) throw new Error('The Claude connection changed. Reload this chat before responding.');
              if (data.action === 'reconnect') {
                if (runtime.snapshot().working) throw new Error('Stop the active turn before reconnecting.');
                await sessions.remove(id); await sessions.resume(id);
                return json(response, 200, { reconnected: true });
              }
              if (session.switchingInterface || session.stopping || session.toolUpdating || session.process !== runtime || session.status !== 'running') throw new Error('Reconnect Claude before sending another action.');
              if (data.action === 'agent-read') return json(response, 200, runtime.subagents.read(data.threadId));
              if (data.action === 'prepare-review') { const result = runtime.prepareReview(data.target); await sessions.persist(); return json(response, 200, result); }
              if (data.action === 'composer-source') return json(response, 200, await runtime.composer.source(data.id));
              if (data.action === 'usage') return json(response, 200, await runtime.refreshUsage());
              if (data.action === 'compact') return json(response, 200, await runtime.compact(data.requestId));
              if (data.action === 'compact-dismiss') return json(response, 200, runtime.dismissCompaction());
              if (data.action === 'steer') return json(response, 200, await runtime.steering.steer(data.text, data.expectedTurnId, data.requestId));
              if (data.action === 'enqueue') return json(response, 200, await runtime.pending.enqueue(data.text, data.requestId));
              if (data.action === 'queue-edit') return json(response, 200, await runtime.pending.edit(data.id, data.text));
              if (data.action === 'queue-cancel') return json(response, 200, await runtime.pending.cancel(data.id));
              if (data.action === 'queue-pause') return json(response, 200, runtime.pending.pause(data.paused));
              if (data.action === 'models') return json(response, 200, { models: runtime.models() });
              if (data.action === 'configure') { const result = await runtime.configure(data.model, data.effort); sessions.changed(session); await sessions.persist(); return json(response, 200, result); }
              if (data.action === 'set-permissions') { const result = data.workMode !== undefined ? await runtime.setWorkMode(data.workMode) : await runtime.setPermissionMode(data.permissionMode); sessions.changed(session); await sessions.persist(); return json(response, 200, result); }
              if (data.action === 'acknowledge-uncertain') return json(response, 200, await runtime.acknowledgeUncertain());
              if (data.action === 'detach-attachment') return json(response, 200, runtime.detach(data.path));
              if (data.action === 'draft') {
                if (typeof data.text !== 'string' || data.text.length > 64000) throw new Error('Draft is too large.');
                runtime.draft = data.text; runtime.draftRevision++; runtime.changed(); return json(response, 200, { saved: true });
              }
            }
            if (data.action === 'models' && runtime.initialized && !runtime.closed) return json(response, 200, { models: await runtime.models() });
            if (session.permissionApplying) throw new Error('Wait for Codex to confirm the permission change.');
            if (session.switchingInterface || session.stopping || session.toolUpdating || session.process !== runtime || session.status !== 'running') throw new Error('Wait for the graphical chat to reconnect.');
            if (data.action === 'send') { session.lastInputAt = new Date().toISOString(); const result = await runtime.submit(data.text); sessions.changed(session); return json(response, 200, result); }
            if (data.action === 'interrupt') return json(response, 200, await runtime.interrupt());
            if (data.action === 'answer') return json(response, 200, runtime.answer(data.id, data.decision, data.answers));
            if (data.action === 'mode') return json(response, 200, await runtime.advanced.selectMode(data.mode) || { configured: true });
            if (data.action === 'usage') return json(response, 200, await runtime.advanced.refreshLimits());
            if (data.action === 'compact' || data.action === 'review') return json(response, 200, await runtime.operations.start(data.action, data.target));
            if (data.action === 'operation-check') return json(response, 200, await runtime.operations.check());
            if (data.action === 'operation-dismiss') return json(response, 200, runtime.operations.dismiss());
            if (data.action === 'agent-read') return json(response, 200, await runtime.operations.readAgent(data.threadId));
            if (data.action === 'enqueue') return json(response, 200, runtime.advanced.enqueue(data.text, data.requestId));
            if (data.action === 'queue-edit') return json(response, 200, runtime.advanced.edit(data.id, data.text));
            if (data.action === 'queue-cancel') return json(response, 200, runtime.advanced.cancel(data.id));
            if (data.action === 'queue-pause') return json(response, 200, runtime.advanced.pause(data.paused));
            if (data.action === 'steer') return json(response, 200, await runtime.advanced.steer(data.text, data.expectedTurnId));
            if (data.action === 'history') return json(response, 200, await runtime.older(data));
            if (data.action === 'search-history') return json(response, 200, await runtime.historySearch.search(data));
            if (data.action === 'search-open') return json(response, 200, await runtime.historySearch.open(data));
            if (data.action === 'reconcile') return json(response, 200, await runtime.reconcile());
            if (data.action === 'open-file') {
              const item = runtime.items.get(data.itemId) || runtime.historyItems.get(data.itemId);
              const fromLink = typeof data.href === 'string';
              const reference = fromLink ? data.href : data.kind === 'change' ? item?.changes?.[data.index]?.path : item?.attachments?.[data.index]?.path;
              if (typeof reference !== 'string' || reference.length > 8192 || /[\x00-\x1f]/.test(reference) || /^[a-z]+:/i.test(reference) && !/^file:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) throw new Error('Choose a local file link.');
              const location = fromLink ? resolveChatFileLink(session.cwd, reference) : { file: path.resolve(session.cwd, reference) };
              const actual = await realpath(location.file);
              if (![repo, session.cwd].some(root => within(root, actual)) && !runtime.previewPaths.has(actual) || /(?:^|[\\/])(?:\.env|auth\.json|credentials)(?:[\\/.]|$)/i.test(actual)) throw new Error('This file is outside this chat’s preview locations. Attach it explicitly first.');
              if (data.destination === 'ide') {
                if (!isDevelopmentFile(actual) || !(await stat(actual)).isFile()) throw new Error('Choose a source or development file to open in the IDE.');
                return json(response, 200, await openIde(actual, location));
              }
              const preview = await files.preview(actual); show('workspace', { preview, userInitiated: true }); return json(response, 200, { opened: preview.name });
            }
            if (data.action === 'draft') { if (typeof data.text !== 'string' || data.text.length > 64000) throw new Error('Draft is too large.'); runtime.draft = data.text; runtime.draftRevision++; if (Array.isArray(data.attachments)) runtime.attachments = runtime.attachments.filter(file => data.attachments.includes(file)); runtime.changed(); runtime.advanced.schedule(); return json(response, 200, { saved: true }); }
            if (data.action === 'models') return json(response, 200, { models: await runtime.models() });
            if (data.action === 'skills') return json(response, 200, await runtime.composer.skills());
            if (data.action === 'composer-add') return json(response, 200, await runtime.composer.add(data.context));
            if (data.action === 'composer-remove') return json(response, 200, runtime.composer.remove(data.id));
            if (data.action === 'composer-detach') return json(response, 200, runtime.composer.detach(data.path));
            if (data.action === 'paste-text') return json(response, 200, await runtime.composer.paste(sessions.stateDir, id, data.text));
            if (data.action === 'sandbox-check') return json(response, 200, await runtime.checkSandbox());
            if (data.action === 'execution-check') return json(response, 200, await runtime.executionDiagnostics());
            if (data.action === 'sandbox-setup') return json(response, 200, await runtime.setupSandbox());
            if (data.action === 'reconnect') {
              if (!runtime.idle() || session.activity !== 'idle') throw new Error('Finish work before reconnecting. Your draft will be retained.');
              await sessions.restartTools(session, { process: runtime, inputAt: session.lastInputAt, permissions: true });
              if (session.graphical !== runtime && session.process === session.graphical) { session.graphical.draft = runtime.draft; session.graphical.attachments = [...runtime.attachments]; session.graphical.composer.restore(runtime.composer.items); session.graphical.previewPaths = new Set(runtime.previewPaths); session.graphical.changed(); }
              return json(response, 200, { reconnected: true });
            }
            if (data.action === 'configure') {
              if (!runtime.idle() || runtime.advanced.queue.length) throw new Error('Finish work and clear the queue before changing model or reasoning.');
              const models = await runtime.models(), model = models.find(item => item.model === (data.model || runtime.model || runtime.effective?.model));
              if (!runtime.idle() || runtime.advanced.queue.length || session.process !== runtime) throw new Error('The conversation changed before applying the selection.');
              if (!model || data.effort && !model.supportedReasoningEfforts?.some(item => item.reasoningEffort === data.effort)) throw new Error('Choose an available model and reasoning level.');
              runtime.model = model.model; session.graphicalModel = model.model;
              runtime.advanced.usage = null;
              session.effort = data.effort || model.defaultReasoningEffort || model.supportedReasoningEfforts?.[0]?.reasoningEffort || undefined;
              runtime.changed(); sessions.changed(session); await sessions.persist(); return json(response, 200, { configured: true });
            }
            throw new Error('Unknown graphical chat action.');
          }
          if (method === 'POST' && action === 'account') return json(response, 200, await sessions.setAccountProfile(id, data.profileId));
          if (method === 'GET' && action === 'conversation') return json(response, 200, await compactConversations.read(sessions.get(id)));
          if (method === 'GET' && action === 'screen') return json(response, 200, await sessions.read(id));
          if (method === 'POST' && action === 'focus') return json(response, 200, focus(id));
          if (method === 'POST' && action === 'toolsrefresh') return json(response, 200, await toolRefresh.apply(id));
          if (method === 'GET' && action === 'nativemessageactions') return json(response, 200, await openCodeMessageActions.list(sessions.get(id), { query: url.searchParams.get('query') || '', offset: Number(url.searchParams.get('offset') || 0) }));
          if (method === 'POST' && action === 'messageaction') {
            const source = sessions.get(id), runtime = source.graphical;
            if (source.agent === 'opencode') {
              const result = await providerMessageReceipt({ sessions, source, request: data, prepare: () => openCodeMessageActions.prepare(source, data), execute: record => openCodeMessageActions.execute(source, data, record, sessionOptions) });
              if (selectedId === source.id) focus(result.session.id); return json(response, 201, result);
            }
            if (source.agent === 'claude' && source.chatInterface === 'chat' && runtime) {
              if (data.runtimeId !== runtime.runtimeId) throw new Error('The Claude connection changed. Reload before branching.');
              await runtime.ensureHistoryItem?.(data.itemId);
              const result = await providerMessageReceipt({ sessions, source, request: data, prepare: async () => {
                if (source.process !== runtime || !runtime.idle() || runtime.pending.pending || source.stopping || source.toolUpdating || source.switchingInterface) throw new Error('Wait for this Claude chat to be idle and connected.');
                await sessions.verifyIdentity(source);
                await prepareClaudeMessageAction(runtime, data.itemId, data.kind);
              }, execute: record => createClaudeMessageBranch({ sessions, source, itemId: data.itemId, kind: data.kind, record, sessionOptions }) });
              if (selectedId === source.id) focus(result.session.id); return json(response, 201, result);
            }
            if (!runtime || source.chatInterface !== 'chat' || source.agent !== 'codex') throw new Error('Message actions require a graphical Codex chat.');
            const result = await providerMessageReceipt({ sessions, source, request: data, prepare: async () => {
              if (source.process !== runtime || !runtime.idle() || runtime.advanced.queue.length || source.permissionApplying || source.stopping || source.toolUpdating) throw new Error('Wait until this graphical chat is idle and connected before branching.');
              await runtime.ensureHistoryItem?.(data.itemId);
              await prepareMessageAction(runtime, data.itemId, data.kind);
            }, execute: () => {
              return createMessageBranch({ sessions, source, itemId: data.itemId, kind: data.kind, sessionOptions });
            } });
            if (selectedId === source.id) focus(result.session.id); return json(response, 201, result);
          }
          if (method === 'POST' && action === 'fork') {
            const source = sessions.get(id);
            if (!['codex', 'claude', 'opencode'].includes(source.agent) || !source.nativeId || source.activity !== 'idle') throw new Error('Fork requires an idle agent chat with a captured native conversation ID.');
            if (source.agent === 'codex' && source.chatInterface === 'chat' && (source.hasConversation === false || !source.graphical?.idle())) throw new Error('Start a conversation and finish the current action before forking this chat.');
            if (source.agent === 'claude') await sessions.verifyIdentity(source);
            const transcript = source.chatInterface === 'chat' || source.agent === 'opencode' ? source.nativeId : source.agent === 'codex' ? await sessions.codexFile(source) : await sessions.claudeFile(source, source.nativeId, { search: true });
            if (!transcript) throw new Error('The native conversation cannot be located. Reconnect it before forking.');
            const fork = await sessions.create(await sessionOptions({ agent: source.agent, chatInterface: source.chatInterface, graphicalModel: source.graphicalModel, cliModelLabel: source.cliModelLabel, accountProfileId: source.accountProfileId, claudeAccountIdentity: source.claudeAccountIdentity, name: `Fork · ${source.name}`, projectId: source.projectId, repositoryId: source.repositoryId || 'hub', cardId: source.cardId, cwd: source.cwd, bypass: source.bypass, codexPermissions: source.codexPermissions, effort: source.effort, resumeId: source.nativeId, fork: true, forkPath: transcript }));
            focus(fork.id); return json(response, 201, fork);
          }
          if (method === 'POST' && action === 'control') {
            const session = sessions.get(id);
            if (session.chatInterface === 'chat') return json(response, 200, data.action === 'interrupt' ? await session.graphical.interrupt() : await session.graphical.submit());
            if (!session.process || !['codex', 'claude', 'opencode'].includes(session.agent)) throw new Error('Control requires a running agent terminal.');
            if (data.action === 'interrupt') {
              if (session.activity !== 'working') throw new Error('This chat is not reporting an active turn.');
              if (session.agent === 'opencode') { await openCodePicker.command(id, 'interrupt'); return json(response, 200, { interrupted: true }); }
              return json(response, 200, sessions.input(id, '\x1b'));
            }
            if (data.action !== 'submit' || session.activity === 'working' || session.attention) throw new Error('The terminal is not ready to submit. Handle native prompts directly.');
            if (session.agent === 'opencode') { await openCodePicker.command(id, 'submit'); return json(response, 200, { submitted: true }); }
            await sessions.verifyIdentity(session);
            return json(response, 200, sessions.input(id, '\r'));
          }
          if (method === 'POST' && action === 'permissions') return json(response, 200, await sessions.setCodexPermissions(id, data.codexPermissions));
          if (method === 'POST' && action === 'stop') return json(response, 200, sessions.stop(id));
          if (method === 'POST' && action === 'resume') { const session = await sessions.resume(id, data.nativeId); focus(id); return json(response, 200, session); }
          if (method === 'POST' && action === 'attach') { const session = sessions.get(id); if (session.agent === 'claude' && session.chatInterface === 'chat' && data.runtimeId !== session.graphical?.runtimeId) throw new Error('The Claude connection changed. Reload before attaching files.'); return json(response, 200, await attach(id, data.paths)); }
          if (method === 'POST' && action === 'nativecontrols') return json(response, 200, await nativeControls.act(sessions.get(id), data));
          if (method === 'POST' && action === 'nativecontext') {
            const session = sessions.get(id), process = session.process, inputAt = session.lastInputAt, launchId = session.openCodeLaunchId;
            if (session.agent !== 'opencode' || session.chatInterface === 'chat' || !process || !launchId || data.launchId !== launchId || session.contextPreparing || session.nativeControlBusy || session.stopping || session.toolUpdating || session.activity !== 'idle' || session.attention || !['selector', 'working-project'].includes(data.action)) throw new Error('Return to this idle OpenCode terminal and reopen its context menu.');
            session.contextPreparing = true;
            try {
              const paths = data.action === 'working-project' ? await attachments.paths([session.cwd]) : [];
              await workers.prepare(id);
              if (session.process !== process || session.openCodeLaunchId !== launchId || session.lastInputAt !== inputAt || session.stopping || session.toolUpdating || session.activity !== 'idle' || session.attention) throw new Error('The native chat changed before preparing context. Nothing was submitted.');
              if (data.action === 'selector') { await openCodePicker.command(id, 'context'); return json(response, 200, { opened: true, submitted: false }); }
              if (Date.now() - Date.parse(inputAt || 0) < 2500) throw new Error('You are typing in this terminal. Wait before preparing a reference.');
              sessions.input(id, attachmentText(paths, session.agent), { coordinator: true, submit: false });
              return json(response, 200, { attached: paths, submitted: false });
            } finally { session.contextPreparing = false; }
          }
          if (method === 'GET' && action === 'nativecontext') {
            const session = sessions.get(id);
            if (session.agent !== 'opencode' || session.chatInterface === 'chat' || !session.process || !session.openCodeLaunchId || session.status !== 'running') throw new Error('Open this OpenCode terminal before preparing context.');
            return json(response, 200, { launchId: session.openCodeLaunchId, hasConversation: !!session.hasConversation, cwd: session.cwd, selectorLabel: session.openCodeFamily === 2 ? 'Open native skill selector' : 'Open native skills and commands' });
          }
          if (method === 'POST' && action === 'clear') return json(response, 200, await sessions.clearScreen(id));
          if (method === 'POST' && action === 'archive') return json(response, 200, await sessions.archive(id, data.archived));
          if (method === 'POST' && action === 'deleteplan') return json(response, 200, await nativeDeletion.plan(id));
          if (method === 'POST' && action === 'deletenative') return json(response, 200, await nativeDeletion.confirm(id, data.token, data.name));
          if (method === 'POST' && action === 'reorder') return json(response, 200, await sessions.reorder(id, data.targetId, data.position));
          if (method === 'POST' && action === 'input') { await sessions.verifyIdentity(sessions.get(id)); return json(response, 200, await sessions.input(id, data.text, { coordinator: data.paste !== false, submit: data.submit !== false })); }
          if (method === 'POST' && action === 'compactinput') {
            await sessions.verifyIdentity(sessions.get(id));
            const session = sessions.get(id), process = session.process, inputAt = session.lastInputAt;
            if (session.agent !== 'codex' || !process || session.stopping || session.toolUpdating || session.permissionApplying || session.activity === 'waiting') throw new Error('Handle the native terminal prompt before sending.');
            if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 64000 || /^[\s]*\//.test(data.text)) throw new Error('Enter a message. Use the native terminal for slash commands.');
            if (!await sessions.permissionReady(session) || session.process !== process || session.lastInputAt !== inputAt || session.activity === 'waiting' || session.stopping || session.toolUpdating || session.permissionApplying) throw new Error('The native prompt is not empty or ready. Show operations and finish native dialogs or drafts first.');
            const result = sessions.input(id, data.text, { coordinator: true, submit: true });
            // Keep native refresh/second submissions away from the paste guard.
            session.lastInputAt = new Date().toISOString();
            return json(response, 200, result);
          }
          if (method === 'POST' && action === 'workingproject') {
            const session = sessions.get(id);
            if (!session.projectId) throw new Error('This chat needs an associated workspace before choosing a working project.');
            if (data.repositoryId !== null && (typeof data.repositoryId !== 'string' || !data.repositoryId)) throw new Error('Choose a linked project or Workspace planning.');
            return json(response, 200, await projects.serialize(async () => {
              const project = await projects.get(session.projectId);
              if (data.repositoryId !== null && !project.repositories.some(item => item.id === data.repositoryId)) throw new Error('The working project does not belong to this workspace.');
              const cwd = data.repositoryId === null ? projectChatFolder(project.id) : await projects.root(project.id, data.repositoryId);
              if (data.repositoryId === null) await mkdir(cwd, { recursive: true });
              const card = session.cardId ? (await registry()).entities.find(item => item.id === session.cardId && item.projectId === project.id) : null;
              const cardId = card && (card.repositoryId || null) === data.repositoryId ? card.id : null;
              return sessions.setWorkingProject(id, { projectId: project.id, repositoryId: data.repositoryId, cwd, cardId }, data.expected);
            }));
          }
          if (method === 'PATCH' && !action && 'projectId' in data) {
            const session = sessions.get(id);
            if (session.locationUpdating) throw new Error('Wait for the working project change before changing workspace.');
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
          native({ type: 'window', action: data.action, window: data.window, value: !!data.value, ...(data.action === 'layout' ? { chatWidthPercent: settings.chatWidthPercent } : {}) }); return json(response, 200, { requested: true });
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
          return json(response, 200, { history: selected ? coordinator.history(projectId, selected) : [], conversations, selected, effort: current?.effort || settings.coordinatorEffort, model: current?.model || null, accountProfileId: current?.accountProfileId || 'system', state: coordinator.state, confirmations: [...coordinator.confirmations.values()].map(item => item.confirmation), active: coordinator.active?.operationId || null });
        }
        if (method === 'GET' && url.pathname === '/api/reasoning') {
          // Saved defaults are preferences for future, potentially different
          // models/accounts. Inspecting them must not start/switch a coordinator
          // runtime or require the now-disallowed system account.
          if (url.searchParams.get('scope') === 'defaults') return json(response, 200, {
            codex: { model: '', efforts: defaultWorkerEfforts, defaultEffort: 'medium' },
            codexWorker: { model: '', efforts: defaultWorkerEfforts, defaultEffort: defaultWorkerEffort },
            claude: { efforts: claudeEfforts, note: '' },
          });
          const result = { codex: { model: '', efforts: [], defaultEffort: 'medium' }, codexWorker: { model: '', efforts: [], defaultEffort: 'medium' }, claude: { efforts: claudeEfforts, note: 'Native Claude effort levels; model and organization limits are enforced by Claude.' } };
          const errors = [];
          try { result.codex = await coordinator.reasoningCapabilities(url.searchParams.get('model') || undefined, { profileId: url.searchParams.get('profileId') || 'system' }); } catch (error) { errors.push(publicError(error)); }
          try { result.codexWorker = await coordinator.reasoningCapabilities(undefined, { worker: true, profileId: url.searchParams.get('profileId') || 'system' }); } catch (error) { errors.push(publicError(error)); }
          return json(response, 200, { ...result, ...(errors.length ? { error: errors.join(' ') } : {}) });
        }
        if (method === 'POST' && url.pathname === '/api/coordinator/conversation') {
          const projectId = data.projectId || null; if (projectId) await projects.get(projectId);
          if (data.action === 'account') { sessions.requireAccount(data.profileId); return json(response, 200, await coordinator.setAccountProfile(projectId, data.id, data.profileId)); }
          if (data.action === 'model') return json(response, 200, await coordinator.setModel(projectId, data.id, data.model));
          if (data.action === 'effort') return json(response, 200, await coordinator.setEffort(projectId, data.id, data.effort));
          if (data.action === 'retry') { if (coordinator.operationPromises.size) throw new Error('Wait for Mak before reconnecting.'); const conversation = coordinator.conversation(projectId); if (!conversation) throw new Error('Create a conversation first.'); await coordinator.start(conversation.accountProfileId || 'system'); await coordinator.ensureThread({ projectId }, conversation); return json(response, 200, { ready: true }); }
          return json(response, 200, data.action === 'select' ? await coordinator.selectConversation(projectId, data.id) : data.action === 'new' || data.action === 'fork' ? await coordinator.newConversation(projectId, data.action === 'fork') : (() => { throw new Error('Unknown conversation action.'); })());
        }
        if (method === 'POST' && url.pathname === '/api/coordinator') return json(response, 200, await askMak(data));
        if (method === 'POST' && url.pathname === '/api/coordinator/confirm') return json(response, 200, coordinator.confirm(data.id, data.approved));
        if (method === 'POST' && url.pathname === '/api/coordinator/cancel') return json(response, 200, await coordinator.cancel(data.id));
        if (method === 'POST' && url.pathname === '/api/coordinator/prepare') { await coordinator.start(data.profileId || 'system'); return json(response, 200, { ready: true, model: coordinator.model }); }
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
    } catch (error) { if (!response.headersSent) { const issue = connectionIssue(error); json(response, error.status || 400, { error: ['unknown', 'configuration'].includes(issue.category) ? publicError(error) : issue.message, connectionIssue: issue }); } }
  });
  const origin = await listen(server);
  sharedBrowsers.origin = origin;
  files.uiOrigin = origin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (closing) { socket.destroy(); return; }
    const url = new URL(request.url, origin);
    if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin) { socket.destroy(); return; }
    if (url.pathname === '/browser-stream') return sharedBrowsers.upgrade(request, socket, head);
    if (url.pathname !== '/events') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.authenticated = false; ws.sessionId = null;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', async raw => {
      try {
        if (closing) return;
        const message = JSON.parse(raw.toString());
        if (!ws.authenticated) {
          if (message.type !== 'auth' || !equalSecret(message.token, token)) return ws.close(1008, 'Authentication failed');
          ws.authenticated = true; ws.clientId = message.clientId; ws.surface = message.surface; clients.add(ws); clearTimeout(authTimer);
          send(ws, 'connected', { sessions: sessions.list(), selectedId, coordinator: coordinator.state, ...(ws.surface === 'workspace' ? { browserSessionId: sharedBrowsers.selectedId || null } : {}) }); return;
        }
        if (workspaceTransferBusy && ['input', 'resize', 'selected', 'seen', 'workspace-route'].includes(message.type)) return;
        if (message.type === 'subscribe') {
          ws.sessionId = message.id;
          if (sessions.get(message.id).chatInterface === 'chat') { send(ws, 'chat-view', { id: message.id }); return; }
          const snapshot = await sessions.snapshot(message.id);
          if (ws.sessionId === message.id) send(ws, 'snapshot', snapshot);
        } else if (message.type === 'input') {
          // Focus reports can arrive just after exit or while restoring a saved
          // screen. They are not an attempted user message to a stopped process.
          if ((message.data === '\x1b[I' || message.data === '\x1b[O') && !sessions.get(message.id).process) return;
          // Keep keystrokes ordered while the newline's local identity check runs.
          const pendingInput = (ws.accountInputChain || Promise.resolve()).catch(() => {}).then(async () => {
            if (typeof message.data === 'string' && /[\r\n]/.test(message.data)) await sessions.verifyIdentity(sessions.get(message.id));
            sessions.input(message.id, message.data);
          });
          ws.accountInputChain = pendingInput; await pendingInput;
        }
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
  try { watcher = watch(path.join(repo, 'workspace', 'workspace.json'), () => { if (!workspaceTransferBusy) broadcast('workspace-changed', {}); }); watcher.on('error', () => {}); } catch { /* Registry may be created after first setup. */ }
  await cardContent.start();
  const prepareLastContext = () => { if (!closing && settings.codexLastGraphicalContext) codexPreparation.request(settings.codexLastGraphicalContext, { delay: 750 }); };
  const restoreTimer = restoreSessions ? setTimeout(() => sessions.restore(() => selectedId, reportStartup).then(prepareLastContext).catch(error => sessions.emit('service-error', error)), 100) : setTimeout(prepareLastContext, 750);
  let closeTask;
  return {
    origin, contentOrigin: files.origin, token, sessions, coordinator, quick, workspace, files, projects, bridge, toolRefresh, accounts, profiles, claudeProfiles, accountLimitReader, sharedBrowsers, browserSettings, codexPreparation,
    get chatWidthPercent() { return settings.chatWidthPercent; },
    urls: { workspace: `${origin}/?desktop=1&surface=workspace&token=${token}`, chats: `${origin}/?desktop=1&surface=chats&token=${token}` },
      nativeMessage: event => { if (event.type === 'workspace-hidden') { for (const record of sharedBrowsers.records.values()) sharedBrowsers.hide(record); } nativeSettings.receive(event); cardRecycler.receive(event); },
      close() {
        if (closeTask) return closeTask;
        closing = true;
        closeTask = (async () => {
          const errors = [];
          clearTimeout(restoreTimer); clearTimeout(settingsTimer);
          // Stop native writers immediately, alongside independent background
          // readers. A slow/failed reader must not strand conversation leases.
          await settleCleanup([
            () => watcher?.close(),
            () => { for (const ws of wss.clients) ws.terminate(); },
            () => sessions.close(), () => coordinator.close(),
            () => codexCliVerifier.close(), () => codexPreparation.close(),
            () => cardContent.close(), () => accountLimitReader.close(), () => accounts.close(),
          ], errors);
          await settleCleanup([
            () => toolRefresh.close(), () => bridge.close(), () => cardRecycler.close(),
            ...[...projectMcps.values()].map(inventory => () => inventory.close()),
            () => mcp.close(), () => nativeSettings.close(),
            // A rejected user mutation was already reported by its API. Drain
            // those queues without treating a past rejection as a close error.
            () => projects.writes.catch(() => {}), () => files.writes.catch(() => {}), () => coordinator.queue,
            () => workspaceMcpLaunches.close(), () => sharedBrowsers.close(),
          ], errors);
          await settleCleanup([
            () => saveSettings(), () => transcriptSave, () => coordinator.saves,
            () => quick.saves, () => workspace.writes,
          ], errors);
          await settleCleanup([
            () => new Promise(resolve => wss.close(resolve)),
            () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
            () => { contentServer.closeAllConnections(); return new Promise(resolve => contentServer.close(resolve)); },
          ], errors);
          if (errors.length) throw new AggregateError(errors, 'Service shutdown did not finish cleanly.');
        })();
        return closeTask;
    },
  };
}
