import { useCallback, useLayoutEffect, useRef } from 'react'

// The callback identity is stable, but it always invokes the latest committed
// handler. Unlike an ignore-functions memo comparator, this preserves actions.
export default function useStableChatCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback)
  useLayoutEffect(() => { latest.current = callback })
  return useCallback((...args: Args) => latest.current(...args), [])
}
