import { useCallback, useLayoutEffect, useRef, useState, memo } from 'react'
import type { ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'

const estimatedTurnHeight = 400
const initialTurns = 2

// Position updates should move a measured row, not rebuild its Markdown tree.
const TurnContents = memo(function TurnContents({ index, render }: { index: number; render: (index: number) => ReactNode }) { return <>{render(index)}</> })

export default function VirtualChatTurns({ keys, getView, render, startAtEnd }: { keys: string[]; getView: () => HTMLDivElement | null; render: (index: number) => ReactNode; startAtEnd: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0), [pinned, setPinned] = useState(() => new Map<string, number>())
  const [retained, setRetained] = useState<string[]>([])
  const revealing = useRef('')
  const enabled = keys.length > 20
  const initialTail = enabled && startAtEnd
  const keyAt = useCallback((index: number) => keys[index], [keys])
  // eslint-disable-next-line react-hooks/incompatible-library -- This headless instance is used directly, never memoized or passed into compiled components.
  const virtual = useVirtualizer({
    count: keys.length, getScrollElement: getView, getItemKey: keyAt, estimateSize: () => estimatedTurnHeight,
    // Seed a tail viewport before the real scroll element can be measured.
    initialRect: initialTail ? { width: 0, height: initialTurns * estimatedTurnHeight } : undefined,
    initialOffset: initialTail ? (keys.length - initialTurns) * estimatedTurnHeight : 0,
    overscan: 3, enabled, scrollMargin: margin, anchorTo: 'end', followOnAppend: false,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...[...retained, ...pinned.keys()].map(key => keys.indexOf(key)).filter(index => index >= 0)])].sort((a, b) => a - b),
  })
  useLayoutEffect(() => {
    const view = getView(), element = root.current
    if (!view || !element) return
    const next = element.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop
    const frame = requestAnimationFrame(() => setMargin(previous => Math.abs(previous - next) < 1 ? previous : next))
    return () => cancelAnimationFrame(frame)
  }, [getView, keys.length, enabled])
  useLayoutEffect(() => {
    const view = getView(); if (!view) return
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id
      const index = [...(root.current?.querySelectorAll<HTMLElement>('[data-chat-item]') || [])].find(item => item.dataset.chatItem === id)
      if (index) return
      const target = (event as CustomEvent<{ index?: number }>).detail.index
      const request = `${id}:${target}`
      if (enabled && target != null && target >= 0 && revealing.current !== request) { revealing.current = request; virtual.scrollToIndex(target, { align: 'center' }) }
    }
    const cancel = () => { virtual.cancelScroll(); revealing.current = '' }
    const end = (event: Event) => { if (enabled) { (event as CustomEvent<{ handled: boolean }>).detail.handled = true; revealing.current = ''; virtual.scrollToEnd({ behavior: 'auto' }) } }
    const pin = (event: Event) => {
      const { key, pin, retain } = (event as CustomEvent<{ key: string; pin?: boolean; retain?: boolean }>).detail
      if (retain) { setRetained(previous => previous[previous.length - 1] === key ? previous : [...previous.filter(value => value !== key), key].slice(-3)); return }
      setPinned(previous => {
        const next = new Map(previous), count = (previous.get(key) || 0) + (pin ? 1 : -1)
        if (count > 0) next.set(key, count)
        else next.delete(key)
        return next
      })
    }
    view.addEventListener('graphical-reveal', reveal); view.addEventListener('graphical-preview-pin', pin); view.addEventListener('graphical-navigation', cancel); view.addEventListener('graphical-scroll-end', end)
    return () => { virtual.cancelScroll(); view.removeEventListener('graphical-reveal', reveal); view.removeEventListener('graphical-preview-pin', pin); view.removeEventListener('graphical-navigation', cancel); view.removeEventListener('graphical-scroll-end', end) }
  }, [getView, enabled, virtual])
  const rows = virtual.getVirtualItems(), totalSize = virtual.getTotalSize()
  const mountedKeys = rows.map(row => row.key).join('\0')
  useLayoutEffect(() => { getView()?.dispatchEvent(new Event('graphical-rows-ready')) }, [getView, render, keys.length, mountedKeys, totalSize])
  if (!enabled) return <div ref={root}>{keys.map((key, index) => <div key={key}><TurnContents index={index} render={render} /></div>)}</div>
  return <div ref={root} className="graphical-windowed" style={{ height: totalSize, position: 'relative' }} data-logical-turns={keys.length}>{rows.map(row => <div key={row.key} data-index={row.index} ref={virtual.measureElement} className="graphical-virtual-turn" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start - margin}px)` }}><TurnContents index={row.index} render={render} /></div>)}</div>
}
