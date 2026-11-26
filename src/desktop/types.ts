export type AgentId = 'codex' | 'claude' | 'opencode' | 'kimi' | 'shell'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface ReasoningCapabilities { codex: { model: string; efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort; models?: { model: string; label: string }[] }; codexWorker: { model: string; efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort }; claude: { efforts: ReasoningEffort[]; note: string }; error?: string }
export interface AgentInfo { id: AgentId; label: string; color: string; available: boolean; subscription: boolean }
export type CodexPermissions = 'native' | 'full-access' | 'ask' | 'auto-review' | 'bypass'
export interface ChatSession {
  linkedMcpOrigins?: { name: string; server: string; repositoryId: string; repository: string }[]
  linkedMcpIssues?: { repository: string; name: string; reason: string }[]
  chatInterface?: 'cli' | 'chat'
  graphicalModel?: string | null
  cliModelLabel?: string | null
  cliModelLaunchId?: string | null
  claudePermissionMode?: string
  claudeBypassAllowed?: boolean
  accountProfileId?: string
  accountProfileLabel?: string
  conversationStoreId?: string | null
  connectionIssue?: { category: string; message: string; details: string; retry: string } | null
  codexPermissions?: CodexPermissions
  codexPermissionsPending?: boolean
  projectId?: string | null
  repositoryId?: string | null
  cardId?: string | null
  id: string; name: string; agent: AgentId; cwd: string; bypass: boolean
  effort?: ReasoningEffort
  nativeUnavailable?: string | null
  toolRefresh?: { status: 'pending' | 'applying' | 'applied' | 'failed'; reason: string; automatic: boolean; silent?: boolean } | null
  status: 'starting' | 'running' | 'stopped' | 'exited'; createdAt: string
  lastOutputAt: string | null; lastInputAt: string | null; nativeId: string | null
  attention: boolean; cols: number; rows: number; exitCode?: number | null
  activity: 'idle' | 'working' | 'waiting'; unread: boolean; completionVersion: number
  tabOrder: number; tabColor: string | null
  open: boolean; pinned: boolean; archived?: boolean; updatedAt: string; preview?: string; hasConversation?: boolean; restoreError?: string | null
}
export interface Notice { id: string; sessionId: string; name: string; kind: string; text: string; at: string }
export interface MakScope { projectId: string | null; repositoryId: string | null; cardId: string | null; selectedId: string | null }
export interface Operation { id: string; text: string; status: string; result?: string; at: string; scope?: MakScope; connectionIssue?: { category: string; message: string; details: string; retry: string } }
export interface Settings { chatShortcuts?: Record<'new' | 'search' | 'history' | 'sidebar', string>; chatWidthPercent?: number; selectedProjectId?: string | null; defaultAgent: AgentId; defaultBypass: boolean; defaultCodexPermissions?: CodexPermissions; defaultClaudePermissions?: 'ask' | 'bypass'; defaultWorkerEffort: ReasoningEffort; defaultClaudeWorkerEffort?: ReasoningEffort; completionNotifications?: boolean; managedBrowser?: 'off' | 'msedge' | 'chrome'; managedBrowserHeadless?: boolean; managedBrowserPresentation?: 'workspace' | 'external'; managedBrowserPresentationProjects?: Record<string, 'workspace' | 'external'>; managedBrowserTemporary?: boolean; managedBrowserTemporaryProjects?: Record<string, boolean>; managedBrowserChats?: Record<string, { choice?: 'off' | 'msedge' | 'chrome'; presentation?: 'workspace' | 'external'; temporary?: boolean }>;  managedBrowserProjects?: Record<string, 'off' | 'msedge' | 'chrome'>; terminalFontSize?: number; terminalAppearance?: 'focus' | 'original'; accentTheme?: 'rose' | 'violet' | 'blue' | 'teal'; workspaceRoute?: string | null; selectedId?: string | null; coordinatorEffort?: ReasoningEffort; voiceName?: string; voiceStyle?: string }
export interface Project { iconRevision?: string | null; id: string; name: string; type: string; status: string; repositories: { id: string; name: string; repositoryPath: string | null; available: boolean }[]; repositoryPath: string | null; available: boolean; branch?: string | null; detected?: Record<string, boolean> }
export interface LibraryResource { id: string; kind: string; path: string; title: string; projectId: string | null; repositoryProjectId?: string }
export interface VoiceOwner { clientId: string; surface: 'chats' | 'workspace' }
export interface FileEntry { name: string; path: string; directory: boolean; size: number; modifiedAt: string | null }
export interface Folder { path: string; parent: string; entries: FileEntry[]; truncated: boolean; mode: string }
export interface Preview { interactiveUrl?: string; originalHtml?: string; viewState?: { zoom?: number | 'fit'; top?: number; left?: number }; identity?: string; blockKind?: 'code' | 'table'; language?: string; cells?: string[][]; source?: { sessionId: string; itemId: string; visualizePath?: string }; path: string; name: string; size: number; kind: 'rich' | 'document' | 'image' | 'video' | 'audio' | 'text' | 'unsupported'; url?: string; text?: string; revision?: string; reason?: string }
export interface DesktopState {
  inspector?: { sessionId: string; itemId: string } | null
  browserSessionId?: string | null
  projects: Project[]
  ready: boolean; connected: boolean; error: string | null; repo: string; contentBase: string
  agents: AgentInfo[]; sessions: ChatSession[]; selectedId: string | null; notices: Notice[]
  settings: Settings; coordinator: string; voice: { configured: boolean; owner: VoiceOwner | null }
  operations: Operation[]; preview: Preview | null
  voiceHistory: { id: string; at: string; captions: { role: 'user' | 'assistant'; text: string; start: number; end: number }[] }[]
}
export interface ServiceEvent {
  userInitiated?: boolean
  pages?: { path: string; status: string; revision?: string }[]
  inspector?: { sessionId: string; itemId: string } | null
  browserSessionId?: string | null
  type: string; id?: string; data?: string; sequence?: number; session?: ChatSession; sessions?: ChatSession[]
  selectedId?: string; sessionId?: string; state?: string; error?: string; notice?: Notice
  operation?: Operation; settings?: Settings; owner?: VoiceOwner | null; window?: string; route?: string; section?: string; preview?: Preview; compose?: { projectId?: string | null; cardId?: string | null }
}
