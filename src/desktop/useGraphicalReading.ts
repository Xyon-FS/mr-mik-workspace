import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from './client'
import type { GraphicalItem, GraphicalTurn } from './GraphicalTimeline'
import { mergeHistoryWindow as merge } from './graphicalHistoryWindow'

export type HistoryWindow = { runtimeId: string; items: GraphicalItem[]; turns: GraphicalTurn[]; nextCursor: string | null; hasOlder: boolean; liveWindow?: boolean }
type History = HistoryWindow
export default function useGraphicalReading(id: string, runtimeId: string | undefined, live: GraphicalItem[], liveTurns: GraphicalTurn[], getView: () => HTMLDivElement | null, options: { hasOlder?: boolean; connected?: boolean } = {}) {
  const [history, setHistory] = useState<History | null>(null)
  const [loadingState, setLoading] = useState<{runtimeId?: string; active: boolean}>({active: false})
  const loading = loadingState.runtimeId === runtimeId && loadingState.active
  const [errorState, setErrorState] = useState<{runtimeId?: string; message: string}>({message: ''})
  const error = errorState.runtimeId === runtimeId ? errorState.message : ''
  const setError = useCallback((message: string) => setErrorState({runtimeId, message}), [runtimeId])
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true), anchor = useRef<{ id: string; top: number } | null>(null), lock = useRef<{runtimeId?: string} | null>(null)
  const userScroll = useRef(false)
  const gestureUntil = useRef(0), gestureDirection = useRef(0), pointerHeld = useRef(false)
  const captureFrame = useRef(0), gestureTimer = useRef(0), positionEpoch = useRef(0), latestFrame = useRef(0)
  const pendingTarget = useRef<string | null>(null)
  const pendingPrepend = useRef<{ id: string; top: number } | null>(null)
  const navigation = useRef(0)
  const currentRuntime = useRef(runtimeId)
  const continuous = useRef<History | null>(null)
  const boundaryLoad = useRef<() => void>(() => {})
  const autofill = useRef({ runtimeId, pages: 0 })
  useLayoutEffect(() => { currentRuntime.current = runtimeId }, [runtimeId])
  const active = history?.runtimeId === runtimeId ? history : null
  const disconnectedWindow = useMemo(() => { const ids = new Set(live.map(item => item.id)); return !!active?.liveWindow && !!live.length && !active.items.some(item => ids.has(item.id)) }, [active, live])
  const items = useMemo(() => active ? active.liveWindow && !disconnectedWindow ? merge(active.items, live) : active.items : live, [active, live, disconnectedWindow])
  const turns = useMemo(() => active ? active.liveWindow && !disconnectedWindow ? merge(active.turns, liveTurns) : active.turns : liveTurns, [active, liveTurns, disconnectedWindow])
  const latestReading = useRef({ items, turns })
  useLayoutEffect(() => { latestReading.current = { items, turns } }, [items, turns])
  useEffect(() => {
    if (!active?.liveWindow || disconnectedWindow || items === active.items && turns === active.turns) return
    const frame = requestAnimationFrame(() => { const next = { ...active, items, turns }; continuous.current = next; setHistory(next) })
    return () => cancelAnimationFrame(frame)
  }, [active, disconnectedWindow, items, turns])
  useEffect(() => {
    if (!disconnectedWindow || !following) return
    const frame = requestAnimationFrame(() => { continuous.current = null; setHistory(null) })
    return () => cancelAnimationFrame(frame)
  }, [disconnectedWindow, following])
  const hasOlder = active?.hasOlder ?? options.hasOlder
  const capture = useCallback(() => {
    const element = getView(); if (!element) return
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.getBoundingClientRect().bottom > top + 5)
    anchor.current = row ? { id: row.dataset.chatItem!, top: row.getBoundingClientRect().top - top } : null
  }, [getView])
  const restore = useCallback(() => {
    const element = getView(); if (!element) return
    // A gesture may produce many scroll frames after its wheel/key event.
    // Restoring a saved anchor during those frames fights native scrolling.
    if (pointerHeld.current || performance.now() < gestureUntil.current) return
    if (pendingTarget.current) {
      const id = pendingTarget.current, row = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.dataset.chatItem === id)
      if (row) {
        let parent: HTMLElement | null = row
        while (parent && parent !== element) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement }
        row.querySelectorAll('details').forEach(details => { details.open = true })
        element.querySelectorAll('[data-search-target]').forEach(item => item.removeAttribute('data-search-target'))
        row.setAttribute('data-search-target', 'true'); row.scrollIntoView({ block: 'center' }); row.tabIndex = -1; row.focus({ preventScroll: true })
        anchor.current = { id, top: row.getBoundingClientRect().top - element.getBoundingClientRect().top }; pendingTarget.current = null
      } else element.dispatchEvent(new CustomEvent('graphical-reveal', { detail: { id } }))
      return
    }
    if (followingRef.current) {
      if (element.scrollHeight - element.clientHeight - element.scrollTop > 1) {
        const detail = { handled: false }
        element.dispatchEvent(new CustomEvent('graphical-scroll-end', { detail }))
        if (!detail.handled) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
      }
      return
    }
    const saved = pendingPrepend.current ?? anchor.current
    const row = saved && [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.dataset.chatItem === saved.id)
    if (saved && row) {
      if (pendingPrepend.current) {
        anchor.current = saved
        pendingPrepend.current = null
        element.dispatchEvent(new Event('graphical-navigation'))
      }
      element.scrollBy({ top: row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top, behavior: 'instant' })
    }
    else if (saved) element.dispatchEvent(new CustomEvent('graphical-reveal', { detail: { id: saved.id } }))
  }, [getView])
  useLayoutEffect(restore, [items, restore])
  useEffect(() => {
    const element = getView(), content = element?.querySelector('.graphical-timeline'); if (!element || !content) return
    let frame = 0
    const invalidatePosition = () => { positionEpoch.current++ }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore) }
    const observer = new ResizeObserver(schedule); observer.observe(content); observer.observe(element)
    const endGesture = () => {
      if (pointerHeld.current) { gestureTimer.current = window.setTimeout(endGesture, 180); return }
      gestureUntil.current = 0; userScroll.current = false; setFollowing(followingRef.current)
      if (followingRef.current || pendingPrepend.current) restore()
      else capture()
    }
    const extend = () => { gestureUntil.current = performance.now() + 180; clearTimeout(gestureTimer.current); gestureTimer.current = window.setTimeout(endGesture, 180) }
    const intent = (direction = 0) => {
      invalidatePosition(); cancelAnimationFrame(latestFrame.current); cancelAnimationFrame(captureFrame.current)
      pendingTarget.current = null; pendingPrepend.current = null; anchor.current = null; userScroll.current = true; gestureDirection.current = direction
      element.dispatchEvent(new Event('graphical-navigation'))
      if (direction <= 0 || element.scrollHeight - element.clientHeight - element.scrollTop > 3) { followingRef.current = false; setFollowing(false) }
      extend()
      // At the top of a short page, an upward gesture may produce no native
      // scroll event. It must still be able to request the preceding page.
      if (direction < 0 && element.scrollTop < Math.min(250, element.clientHeight * .5)) boundaryLoad.current()
    }
    const contentInteraction = (event: Event) => { invalidatePosition(); cancelAnimationFrame(latestFrame.current); cancelAnimationFrame(captureFrame.current); pendingTarget.current = null; pendingPrepend.current = null; followingRef.current = false; userScroll.current = false; if ((event as CustomEvent<{ held?: boolean }>).detail?.held) pointerHeld.current = true; capture(); extend() }
    const contentWheel = (event: Event) => { const delta = (event as CustomEvent<number>).detail; if (!Number.isFinite(delta)) return; intent(Math.sign(delta)); element.scrollBy({ top: Math.max(-1000, Math.min(1000, delta)), behavior: 'instant' }) }
    const wheel = (event: WheelEvent) => { if (event.deltaY || !event.deltaX) intent(Math.sign(event.deltaY)) }
    const touch = () => { pointerHeld.current = true; intent() }
    const pointer = (event: PointerEvent) => { if (event.target === element) { pointerHeld.current = true; intent() } }
    const release = () => { if (pointerHeld.current) { pointerHeld.current = false; extend() } }
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) intent(['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : 1)
    }
    const continuingScroll = () => { if (userScroll.current) extend() }
    element.addEventListener('graphical-content-interaction', contentInteraction); element.addEventListener('graphical-content-wheel', contentWheel); element.addEventListener('graphical-content-release', release)
    element.addEventListener('wheel', wheel, { passive: true }); element.addEventListener('touchstart', touch, { passive: true }); element.addEventListener('pointerdown', pointer); element.addEventListener('keydown', keyboard); element.addEventListener('scroll', continuingScroll, { passive: true })
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release); element.addEventListener('touchend', release); element.addEventListener('touchcancel', release)
    window.addEventListener('blur', release)
    element.addEventListener('load', schedule, true); element.addEventListener('graphical-rows-ready', schedule)
    return () => { element.removeEventListener('graphical-content-interaction', contentInteraction); element.removeEventListener('graphical-content-wheel', contentWheel); element.removeEventListener('graphical-content-release', release); invalidatePosition(); cancelAnimationFrame(frame); cancelAnimationFrame(captureFrame.current); cancelAnimationFrame(latestFrame.current); clearTimeout(gestureTimer.current); window.removeEventListener('blur', release); observer.disconnect(); element.removeEventListener('load', schedule, true); element.removeEventListener('graphical-rows-ready', schedule); element.removeEventListener('wheel', wheel); element.removeEventListener('touchstart', touch); element.removeEventListener('pointerdown', pointer); element.removeEventListener('keydown', keyboard); element.removeEventListener('scroll', continuingScroll); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); element.removeEventListener('touchend', release); element.removeEventListener('touchcancel', release) }
  }, [getView, restore, capture])
  const onScroll = () => {
    const element = getView(); if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 3
    const containsLatest = !active || active.items[active.items.length - 1]?.id === live[live.length - 1]?.id
    const next = atBottom && gestureDirection.current >= 0 && (containsLatest || !!active?.liveWindow && userScroll.current)
    if (next && active?.liveWindow) { setError(''); anchor.current = null }
    if (userScroll.current) { followingRef.current = next; setFollowing(next); if (!next && !pendingPrepend.current) { anchor.current = null; cancelAnimationFrame(captureFrame.current); const epoch = positionEpoch.current; captureFrame.current = requestAnimationFrame(() => { if (epoch === positionEpoch.current && !followingRef.current && !pendingPrepend.current) capture() }) } }
    if (!next && !active && userScroll.current && runtimeId && live.length) setHistory({ runtimeId, items: live, turns: liveTurns, nextCursor: null, hasOlder: !!options.hasOlder, liveWindow: true })
    if (!next && userScroll.current && hasOlder && !loading && !error && options.connected) { const epoch = positionEpoch.current; requestAnimationFrame(() => { if (epoch === positionEpoch.current && !followingRef.current && element.scrollTop < Math.min(250, element.clientHeight * .5)) void older() }) }
  }
  const older = useCallback(async (fillViewport = false) => {
    if (lock.current && lock.current.runtimeId === runtimeId || !items.length || hasOlder === false || !options.connected) return
    const request = {runtimeId}
    lock.current = request; setLoading({runtimeId, active: true}); setError(''); capture();
    if (!fillViewport) { followingRef.current = false; setFollowing(false) }
    const requestedRuntime = runtimeId
    const requestedNavigation = navigation.current
    try {
      const page = await api<Omit<History, 'runtimeId'>>(`/sessions/${id}/chat`, { action: 'history', runtimeId, beforeId: items[0].id, cursor: active?.nextCursor })
      if (currentRuntime.current !== requestedRuntime || navigation.current !== requestedNavigation) return
      capture()
      if (!followingRef.current) pendingPrepend.current = anchor.current
      const combined = merge(page.items, latestReading.current.items)
      const advanced = combined[0]?.id !== items[0]?.id || page.nextCursor !== active?.nextCursor
      const next = { ...page, runtimeId: requestedRuntime || '', items: combined, turns: merge(page.turns, latestReading.current.turns), hasOlder: page.hasOlder && advanced, liveWindow: active?.liveWindow !== false }
      if (next.liveWindow) continuous.current = next
      setHistory(next)
    } catch (cause) { if (currentRuntime.current === requestedRuntime && navigation.current === requestedNavigation) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (lock.current === request) { lock.current = null; setLoading({runtimeId, active: false}) } }
  }, [active, capture, hasOlder, id, items, options.connected, runtimeId, setError])
  useLayoutEffect(() => {
    boundaryLoad.current = () => { if (!loading && !error && hasOlder) void older() }
  }, [older, loading, error, hasOlder])
  useEffect(() => {
    if (!items.length || !hasOlder || loading || error || !options.connected) return
    const frame = requestAnimationFrame(() => {
      const view = getView()
      // Fill an initially sparse restored page automatically. Keep the native
      // history window bounded and preserve follow-latest until a user scrolls.
      if (autofill.current.runtimeId !== runtimeId) autofill.current = { runtimeId, pages: 0 }
      if (view?.clientHeight && view.scrollHeight <= view.clientHeight + 1 && followingRef.current && autofill.current.pages < 3) { autofill.current.pages++; void older(true) }
    })
    return () => cancelAnimationFrame(frame)
  }, [items, hasOlder, loading, error, options.connected, getView, older, runtimeId])
  const cancelPositioning = useCallback(() => { pendingPrepend.current = null; positionEpoch.current++; cancelAnimationFrame(latestFrame.current); cancelAnimationFrame(captureFrame.current); clearTimeout(gestureTimer.current); gestureUntil.current = 0; gestureDirection.current = 0; pointerHeld.current = false; getView()?.dispatchEvent(new Event('graphical-navigation')) }, [getView])
  const reveal = useCallback((page: HistoryWindow & { anchorId: string }) => {
    if (currentRuntime.current !== page.runtimeId || !page.items.some(item => item.id === page.anchorId)) return false
    cancelPositioning(); navigation.current++
    pendingTarget.current = page.anchorId; anchor.current = null; userScroll.current = false; followingRef.current = false; setFollowing(false); setError(''); setHistory(page); return true
  }, [cancelPositioning, setError])
  const latest = () => { cancelPositioning(); navigation.current++; pendingTarget.current = null; if (disconnectedWindow) { continuous.current = null; setHistory(null) } else if (active && !active.liveWindow) setHistory(continuous.current?.runtimeId === runtimeId ? continuous.current : null); setError(''); followingRef.current = true; userScroll.current = false; setFollowing(true); anchor.current = null;
    const epoch = positionEpoch.current; let frames = 0, stable = 0
    const settle = () => { if (epoch !== positionEpoch.current || !followingRef.current) return; restore(); const view = getView(); stable = view && view.scrollHeight - view.clientHeight - view.scrollTop <= 1 ? stable + 1 : 0; if (++frames < 60 && stable < 2) latestFrame.current = requestAnimationFrame(settle) }
    latestFrame.current = requestAnimationFrame(settle)
  }
  const focus = (itemId: string) => { cancelPositioning(); pendingTarget.current = itemId; followingRef.current = false; setFollowing(false); anchor.current = null; requestAnimationFrame(restore) }
  return { items, turns, older, latest, reveal, focus, onScroll, historical: !following, historyLoaded: !!active && (!active.liveWindow || active.items.length > live.length), following, hasOlder, loading, error }
}
