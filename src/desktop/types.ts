export type AgentId = 'codex' | 'claude' | 'kimi' | 'shell'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface ReasoningCapabilities { codex: { model: string; efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort; models?: { model: string; label: string }[] }; codexWorker: { model: string; efforts: ReasoningEffort[]; defaultEffort: ReasoningEffort }; claude: { efforts: ReasoningEffort[]; note: string }; error?: string }
export interface AgentInfo { id: AgentId; label: string; color: string; available: boolean; subscription: boolean }
export interface ChatSession {
  projectId?: string | null
  repositoryId?: string | null
  cardId?: string | null
  id: string; name: string; agent: AgentId; cwd: string; bypass: boolean
  effort?: ReasoningEffort
  status: 'starting' | 'running' | 'stopped' | 'exited'; createdAt: string
  lastOutputAt: string | null; lastInputAt: string | null; nativeId: string | null
  attention: boolean; cols: number; rows: number; exitCode?: number | null
  activity: 'idle' | 'working' | 'waiting'; unread: boolean; completionVersion: number
  tabOrder: number; tabColor: string | null
  open: boolean; pinned: boolean; archived?: boolean; updatedAt: string; preview?: string; hasConversation?: boolean; restoreError?: string | null
}
export interface Notice { id: string; sessionId: string; name: string; kind: string; text: string; at: string }
export interface MakScope { projectId: string | null; repositoryId: string | null; cardId: string | null; selectedId: string | null }
export interface Operation { id: string; text: string; status: string; result?: string; at: string; scope?: MakScope }
export interface Settings { selectedProjectId?: string | null; defaultAgent: AgentId; defaultBypass: boolean; defaultWorkerEffort: ReasoningEffort; defaultClaudeWorkerEffort?: ReasoningEffort; terminalFontSize?: number; terminalAppearance?: 'focus' | 'original'; accentTheme?: 'rose' | 'violet' | 'blue' | 'teal'; workspaceRoute?: string | null; selectedId?: string | null; coordinatorEffort?: ReasoningEffort; voiceName?: string; voiceStyle?: string }
export interface Project { id: string; name: string; type: string; status: string; repositories: { id: string; name: string; repositoryPath: string | null; available: boolean }[]; repositoryPath: string | null; available: boolean; branch?: string | null; detected?: Record<string, boolean> }
export interface LibraryResource { id: string; kind: string; path: string; title: string; projectId: string | null; repositoryProjectId?: string }
export interface VoiceOwner { clientId: string; surface: 'chats' | 'workspace' }
export interface FileEntry { name: string; path: string; directory: boolean; size: number; modifiedAt: string | null }
export interface Folder { path: string; parent: string; entries: FileEntry[]; truncated: boolean; mode: string }
export interface Preview { path: string; name: string; size: number; kind: 'document' | 'image' | 'video' | 'audio' | 'text' | 'unsupported'; url?: string; text?: string; revision?: string; reason?: string }
export interface DesktopState {
  projects: Project[]
  ready: boolean; connected: boolean; error: string | null; repo: string; contentBase: string
  agents: AgentInfo[]; sessions: ChatSession[]; selectedId: string | null; notices: Notice[]
  settings: Settings; coordinator: string; voice: { configured: boolean; owner: VoiceOwner | null }
  operations: Operation[]; preview: Preview | null
  voiceHistory: { id: string; at: string; captions: { role: 'user' | 'assistant'; text: string; start: number; end: number }[] }[]
}
export interface ServiceEvent {
  type: string; id?: string; data?: string; sequence?: number; session?: ChatSession; sessions?: ChatSession[]
  selectedId?: string; sessionId?: string; state?: string; error?: string; notice?: Notice
  operation?: Operation; settings?: Settings; owner?: VoiceOwner | null; window?: string; route?: string; section?: string; preview?: Preview; compose?: { projectId?: string | null; cardId?: string | null }
}
