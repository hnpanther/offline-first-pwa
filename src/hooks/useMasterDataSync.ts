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

  const attemptPull = useCallback(async () => {
    if (!navigator.onLine || !authSession) return
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

export function useForceBootstrapPull(): () => Promise<{ success: boolean; error?: string }> {
  return useCallback(async () => {
    const result = await pullBootstrapIfStale(0)
    return { success: result.success, error: result.error }
  }, [])
}

/** @deprecated Use useForceBootstrapPull */
export const useForceMasterDataPull = useForceBootstrapPull
