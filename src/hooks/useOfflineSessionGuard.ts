import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { getSettings } from '@/services/storage'
import { currentOfflineSessionVerdict, type OfflineSessionVerdict } from '@/services/auth/offlineSession'
import { useAuth } from '@/hooks/useAuth'

/** How often a signed-in app re-checks the ceiling while it stays open. */
export const OFFLINE_SESSION_CHECK_INTERVAL_MS = 60_000

/**
 * The asset form: the one screen holding typed values that exist only in memory until saved.
 * `/logsheets/active` and `/logsheets/history` are lists, not forms.
 */
export function isFillRoute(pathname: string): boolean {
  const match = /^\/logsheets\/([^/]+)\/?$/.exec(pathname)
  return match != null && match[1] !== 'active' && match[1] !== 'history'
}

/**
 * What starts a check, and whether that trigger may interrupt the asset form.
 *
 * `start` and `route` always may: at start nothing is typed yet, and a navigation has already left
 * the form. `timer` and `visible` may not — they fire while somebody may be halfway through a
 * reading, and the lock would discard it. Held back there, the lock lands at the next navigation or
 * the next start.
 */
export type OfflineSessionTrigger = 'start' | 'route' | 'timer' | 'visible'

export function mayInterrupt(trigger: OfflineSessionTrigger, pathname: string): boolean {
  if (trigger === 'start' || trigger === 'route') return true
  return !isFillRoute(pathname)
}

/**
 * Enforces the offline-session ceiling (backend V28; `services/auth/offlineSession.ts`) for as long
 * as the signed-in layout is mounted, and returns the latest verdict so the layout can warn before
 * the lock lands.
 */
export function useOfflineSessionGuard(): OfflineSessionVerdict {
  const location = useLocation()
  const { signOut } = useAuth()
  const [verdict, setVerdict] = useState<OfflineSessionVerdict>({ locked: false })
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname
  const lockingRef = useRef(false)

  const check = useCallback(
    async (trigger: OfflineSessionTrigger) => {
      if (lockingRef.current) return
      let next: OfflineSessionVerdict
      try {
        next = await currentOfflineSessionVerdict((await getSettings()).offlineSessionLimit)
      } catch {
        // The policy could not be read. Not locking is the reading that cannot cost work; the next
        // check tries again.
        return
      }
      setVerdict(next)
      if (!next.locked || !mayInterrupt(trigger, pathRef.current)) return
      lockingRef.current = true
      console.warn('[offline-session] locking: no answer from the server for too long', next)
      await signOut({ offlineLocked: next.reason ?? 'limit' })
    },
    [signOut]
  )

  // Start, and every navigation. The trigger is decided from the path actually changing, not from
  // the effect re-running: a re-run for any other reason must not be allowed to interrupt a form.
  const lastPathRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastPathRef.current
    lastPathRef.current = location.pathname
    const trigger: OfflineSessionTrigger =
      previous === null ? 'start' : previous !== location.pathname ? 'route' : 'visible'
    void check(trigger)
  }, [location.pathname, check])

  // While it stays open, and whenever it comes back to the foreground.
  useEffect(() => {
    const timer = setInterval(() => void check('timer'), OFFLINE_SESSION_CHECK_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check('visible')
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  return verdict
}
