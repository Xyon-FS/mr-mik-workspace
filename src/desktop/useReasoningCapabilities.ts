import { useEffect, useState } from 'react'
import { api } from './client'
import type { ReasoningCapabilities } from './types'

export function useReasoningCapabilities(model?: string | null) {
  const key = model || null
  const [result, setResult] = useState<{ key: string | null; data: ReasoningCapabilities | null; error: string } | null>(null)
  useEffect(() => {
    let live = true
    void api<ReasoningCapabilities>(`/reasoning${key ? `?model=${encodeURIComponent(key)}` : ''}`).then(data => { if (live) setResult({ key, data, error: data.error || '' }) }).catch(cause => { if (live) setResult({ key, data: null, error: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { live = false }
  }, [key])
  return result?.key === key ? result : { data: null, error: '' }
}
