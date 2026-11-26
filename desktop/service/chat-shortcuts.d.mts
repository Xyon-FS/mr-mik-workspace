export type ChatShortcut = 'new' | 'search' | 'history' | 'sidebar'
export type ChatShortcuts = Record<ChatShortcut, string>
export const defaultChatShortcuts: Readonly<ChatShortcuts>
export function shortcutError(value: string, current: ChatShortcuts, key: ChatShortcut): string
export function validateChatShortcuts(value: unknown): ChatShortcuts
