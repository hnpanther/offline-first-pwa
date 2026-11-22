import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppStore } from '@/store'
import { useAuth } from '@/hooks/useAuth'
import { mayInterrupt, type OfflineSessionTrigger } from '@/hooks/useOfflineSessionGuard'
import { checkDeviceStatus } from '@/services/device/deviceWipe'
import {
  isDeviceStatusCheckDue,
  lastDeviceStatusCheck,
  recordDeviceStatusCheck
} from '@/services/device/deviceStatusWatch'

/** How often the hook looks whether a check is due; the check itself is throttled to 30 minutes. */
const TICK_MS = 5 * 60 * 1000

/**
 * While a session is open, asks the server about this device at most every 30 minutes (backend
 * V28; `services/device/deviceStatusWatch.ts` says why). Mounted in `AppLayout`.
 *
 * - **A wipe order** is carried out at once (the app reloads into `resumeDeviceWipe`) — even over an
 *   open form: an administrator ordered everything on this device destroyed, typed values included.
 * - **A revoke** (enrolment enforced, no wipe) signs the operator out, keeping every round — but, like
 *   the offline-session lock, never over the asset form on a timer or a return to the app: there it
 *   waits for the next navigation.
 */
export function useDeviceStatusWatch(): void {
  const location = useLocation()
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const { signOut } = useAuth()
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname
  const inFlight = useRef(false)
  const revokedPending = useRef(false)
  const signingOut = useRef(false)

  const signOutRevoked = useCallback(async () => {
    if (signingOut.current) return
    signingOut.current = true
    console.warn('[device] this device was revoked; signing out (local work is kept)')
    await signOut({ deviceRevoked: true })
  }, [signOut])

  const check = useCallback(
    async (trigger: OfflineSessionTrigger) => {
      if (inFlight.current || signingOut.current) return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return
      if (useAppStore.getState().serverReachable === false) return
      // Claimed before the first await: two triggers arriving together (a reconnection and a return
      // to the foreground) must not both read «due» and both ask — found live as two challenges.
      inFlight.current = true
      try {
        const now = Date.now()
        if (!isDeviceStatusCheckDue(await lastDeviceStatusCheck(), now)) return
        await recordDeviceStatusCheck(now)
        const outcome = await checkDeviceStatus()
        if (outcome !== 'revoked') return
        if (mayInterrupt(trigger, pathRef.current)) {
          await signOutRevoked()
        } else {
          revokedPending.current = true
        }
      } finally {
        inFlight.current = false
      }
    },
    [signOutRevoked]
  )

  // Start, and coming back online or the server becoming reachable again. Only the first is a
  // «start»: a reconnection can happen in the middle of a form, so it must not interrupt one.
  const startedRef = useRef(false)
  useEffect(() => {
    if (!isOnline || serverReachable === false) return
    const trigger: OfflineSessionTrigger = startedRef.current ? 'visible' : 'start'
    startedRef.current = true
    void check(trigger)
  }, [isOnline, serverReachable, check])

  // A revoke held back by the asset form lands at the next navigation.
  const lastPathRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastPathRef.current
    lastPathRef.current = location.pathname
    if (previous !== null && previous !== location.pathname && revokedPending.current) {
      revokedPending.current = false
      void signOutRevoked()
    }
  }, [location.pathname, signOutRevoked])

  // While it stays open, and when it returns to the foreground.
  useEffect(() => {
    const timer = setInterval(() => void check('timer'), TICK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check('visible')
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])
}
