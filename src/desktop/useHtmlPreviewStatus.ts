import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

type Status = { key: string; ready: boolean; timedOut: boolean; errors: string[] }

export function useHtmlPreviewStatus(frame: RefObject<HTMLIFrameElement | null>, url: string, attempt: number) {
  const key = `${url}:${attempt}`
  const [status, setStatus] = useState<Status>()
  useLayoutEffect(() => {
    if (!url) return
    const initial: Status = { key, ready: false, timedOut: false, errors: [] }
    const timer = window.setTimeout(() => setStatus(previous => ({ ...(previous?.key === key ? previous : initial), timedOut: true })), 6000)
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'mr-mik-preview') return
      if (event.data.kind === 'ready') {
        clearTimeout(timer)
        setStatus(previous => ({ ...(previous?.key === key ? previous : initial), ready: true, timedOut: false }))
      } else if (['warn', 'error'].includes(event.data.kind) && typeof event.data.message === 'string') {
        const message = event.data.message.slice(0, 2000)
        setStatus(previous => {
          const current = previous?.key === key ? previous : initial
          return { ...current, errors: [...current.errors, message].slice(-30) }
        })
      }
    }
    window.addEventListener('message', receive)
    return () => { clearTimeout(timer); window.removeEventListener('message', receive) }
  }, [frame, key, url])
  const current = status?.key === key ? status : undefined
  return { ready: current?.ready, timedOut: current?.timedOut, errors: current?.errors || [], clearErrors: () => setStatus(previous => previous && { ...previous, errors: [] }) }
}
