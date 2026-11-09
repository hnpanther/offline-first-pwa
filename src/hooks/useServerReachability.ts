import { useCallback, useEffect, useState } from 'react'
import { resolveBaseUrl } from '@/services/api/client'
import { PROBE_INTERVAL_MS, probeServer, type Reachability } from '@/services/api/serverProbe'

/**
 * Keeps asking whether the server at `serverUrl` answers, while the page is on screen.
 *
 * Re-asks on the things that change the answer: a new address, the network coming or going, the
 * page becoming visible again (a tablet woken from sleep), every {@link PROBE_INTERVAL_MS} while
 * visible, and on demand — the login page calls `recheck` after a failed login, so the dot
 * agrees with the error underneath it.
 *
 * Two details that keep the dot honest:
 * - Only the newest probe may set the answer. Otherwise a slow probe started before the network
 *   dropped could land after a fast one started after it, and paint green over red.
 * - The answer is stored with the address it is about. A new address reads as "checking" at
 *   once, instead of showing the old address's colour until its first probe returns; a recheck of
 *   the same address keeps its colour instead of flashing grey.
 */
export function useServerReachability(serverUrl: string): {
  reachability: Reachability
  recheck: () => void
} {
  const [answer, setAnswer] = useState<{ url: string; value: Reachability } | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let disposed = false
    let latest = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void run(), PROBE_INTERVAL_MS)
    }

    const run = async () => {
      clearTimeout(timer)
      if (disposed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Nobody is looking. The visibility listener asks again the moment somebody is.
        return
      }
      const mine = ++latest
      const ok = await probeServer(resolveBaseUrl(serverUrl), { signal: controller.signal })
      if (disposed || mine !== latest) return
      setAnswer({ url: serverUrl, value: ok ? 'reachable' : 'unreachable' })
      schedule()
    }

    const onOffline = () => {
      // No network at all is already the answer; asking would only wait out the timeout.
      latest++
      clearTimeout(timer)
      setAnswer({ url: serverUrl, value: 'unreachable' })
    }
    const onOnline = () => void run()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run()
    }

    void run()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [serverUrl, generation])

  const recheck = useCallback(() => setGeneration(g => g + 1), [])
  const reachability: Reachability = answer && answer.url === serverUrl ? answer.value : 'checking'
  return { reachability, recheck }
}
