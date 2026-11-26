import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

export function retainChatPreview(source: HTMLElement | null) {
  const turn = source?.closest<HTMLElement>('[data-turn-id]'), key = turn?.dataset.turnId
  if (key) turn.closest('.graphical-messages')?.dispatchEvent(new CustomEvent('graphical-preview-pin', { detail: { key, retain: true } }))
}

export function focusChatPreviewSource(source: HTMLElement | null) {
  const closed = source?.closest('details.graphical-turn-process:not([open])')
  const target = closed?.querySelector<HTMLElement>(':scope > summary') || source
  if (target?.isConnected) target.focus({ preventScroll: true })
}

export function useChatPreviewPin(open: boolean, source: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open) return
    const turn = source.current?.closest<HTMLElement>('[data-turn-id]'), view = turn?.closest('.graphical-messages')
    if (!turn || !view) return
    const key = turn.dataset.turnId
    view.dispatchEvent(new CustomEvent('graphical-preview-pin', { detail: { key, pin: true } }))
    return () => { view.dispatchEvent(new CustomEvent('graphical-preview-pin', { detail: { key, pin: false } })) }
  }, [open, source])
}

