import { useEffect, useState } from 'react'
import { api } from './client'
import type { ReasoningCapabilities } from './types'

export function useReasoningCapabilities(model?: string | null, profileId = 'system', scope: 'model' | 'defaults' = 'model') {
  const key = `${scope}:${profileId}:${model || ''}`
  const [result, setResult] = useState<{ key: string | null; data: ReasoningCapabilities | null; error: string } | null>(null)
  useEffect(() => {
    let live = true
    void api<ReasoningCapabilities>(`/reasoning?profileId=${encodeURIComponent(profileId)}&scope=${scope}${model ? `&model=${encodeURIComponent(model)}` : ''}`).then(data => { if (live) setResult({ key, data, error: data.error || '' }) }).catch(cause => { if (live) setResult({ key, data: null, error: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { live = false }
  }, [key, model, profileId, scope])
  return result?.key === key ? result : { data: null, error: '' }
}
