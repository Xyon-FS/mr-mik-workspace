import { useLayoutEffect, useRef } from 'react'

type Position = { top?: number; left?: number; zoom?: number | 'fit'; nested?: Record<string, { top: number; left: number }> }
const memory = new Map<string, Position>()
export function previewMemory(key: string) { return memory.get(key) || {} }
export function rememberPreview(key: string, value: Position) {
  const previous = memory.get(key); memory.delete(key); memory.set(key, { ...previous, ...value })
  while (memory.size > 40) memory.delete(memory.keys().next().value!)
}
export function usePreviewViewport(key: string) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return
    const saved = previewMemory(key); let navigating = false
    const restore = () => { if (!navigating) {
      element.scrollTop = saved.top || 0; element.scrollLeft = saved.left || 0
      for (const [path, position] of Object.entries(saved.nested || {})) {
        let child: Element | undefined = element
        for (const index of path.split('.')) child = child?.children[Number(index)]
        if (child instanceof HTMLElement) { child.scrollTop = position.top; child.scrollLeft = position.left }
      }
    } }
    const intent = () => { navigating = true }
    const save = (event?: Event) => {
      if (!navigating || !element.getClientRects().length) return
      const target = event?.target
      if (target instanceof HTMLElement && target !== element && element.contains(target)) {
        const indexes: number[] = []; let child: Element = target
        while (child !== element && child.parentElement) { indexes.unshift([...child.parentElement.children].indexOf(child)); child = child.parentElement }
        const nested = { ...previewMemory(key).nested, [indexes.join('.')]: { top: target.scrollTop, left: target.scrollLeft } }
        const limited = Object.fromEntries(Object.entries(nested).slice(-12))
        rememberPreview(key, { nested: limited })
      }
      rememberPreview(key, { top: element.scrollTop, left: element.scrollLeft })
    }
    const observer = new ResizeObserver(restore)
    observer.observe(element); if (element.firstElementChild) observer.observe(element.firstElementChild)
    const mutations = new MutationObserver(() => { if (element.firstElementChild) observer.observe(element.firstElementChild); restore() }); mutations.observe(element, { childList: true, subtree: true })
    element.addEventListener('wheel', intent, { passive: true }); element.addEventListener('pointerdown', intent); element.addEventListener('touchstart', intent, { passive: true }); element.addEventListener('keydown', intent); element.addEventListener('scroll', save, { passive: true, capture: true }); element.addEventListener('load', restore, true)
    restore()
    return () => { save(); observer.disconnect(); mutations.disconnect(); element.removeEventListener('wheel', intent); element.removeEventListener('pointerdown', intent); element.removeEventListener('touchstart', intent); element.removeEventListener('keydown', intent); element.removeEventListener('scroll', save, true); element.removeEventListener('load', restore, true) }
  }, [key])
  return ref
}
