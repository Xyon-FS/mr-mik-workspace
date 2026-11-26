import { api, reportError, useDesktop } from './client'
import { defaultChatShortcuts, type ChatShortcuts } from '../../desktop/service/chat-shortcuts.mjs'
export { defaultChatShortcuts, shortcutError } from '../../desktop/service/chat-shortcuts.mjs'
export type { ChatShortcut, ChatShortcuts } from '../../desktop/service/chat-shortcuts.mjs'

export const shortcutChord = (event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>) => {
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
  return [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+')
}
export function useChatShortcuts() {
  const { settings } = useDesktop()
  const save = (value: ChatShortcuts) => { void api('/settings', { chatShortcuts: value }).catch(reportError) }
  return [settings.chatShortcuts || defaultChatShortcuts, save] as const
}
