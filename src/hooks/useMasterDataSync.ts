/**
 * useBootstrapSync
 *
 * Pulls lightweight bootstrap (operational units) on mount and when online.
 * Per-sheet reference data arrives via inbox bundles — never a full master dump.
 */

import { useEffect, useCallback, useRef } from 'react'
import { pullBootstrapIfStale } from '@/services/sync/pullBootstrap'
import { useAppStore } from '@/store'

const STALE_AFTER_MS = 60 * 60 * 1000

export function useMasterDataSync(): void {
  const isOnline = useAppStore(s => s.isOnline)
  const authSession = useAppStore(s => s.authSession)
  const isMounted = useRef(true)
  const pulledForSession = useRef<string | null>(null)

  const attemptPull = useCallback(async () => {
    if (!navigator.onLine || !authSession) return

    // A fresh sign-in always pulls, ignoring the hourly throttle.
    //
    // Bootstrap now carries server-owned rules (the attachment ceilings), not just operational
    // units. Waiting up to an hour to apply an administrator's change is defensible for a
    // running session, but a device that has just signed in should start from the current
    // rules — and "log out and back in" is the one instruction support can reliably give.
    const sessionKey = authSession.username + ':' + authSession.expiresAt
    if (pulledForSession.current !== sessionKey) {
      pulledForSession.current = sessionKey
      await pullBootstrapIfStale(0)
      return
    }

    await pullBootstrapIfStale(STALE_AFTER_MS)
  }, [authSession])

  useEffect(() => {
    isMounted.current = true
    void attemptPull()
    return () => { isMounted.current = false }
  }, [attemptPull])

  useEffect(() => {
    if (isOnline) {
      void attemptPull()
    }
  }, [isOnline, attemptPull])
}
