import { createContext, useContext, type ReactNode } from 'react'

export const ConversationChrome = createContext<{ actions?: ReactNode; account?: ReactNode; summary?: ReactNode; context?: ReactNode }>({})
export const useConversationChrome = () => useContext(ConversationChrome)
