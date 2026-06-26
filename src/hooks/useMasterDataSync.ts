/**
 * useMasterDataSync
 *
 * Pulls master data (config) from the server on mount and whenever
 * the device comes back online.
 *
 * Call this once at the app root level (AppLayout).
 * It does NOT block the UI — the app works offline immediately from IndexedDB.
 */

import { useEffect, useCallback, useRef } from 'react'
import { pullMasterDataIfStale } from '@/services/sync/pullMasterData'
import { useAppStore } from '@/store'

const STALE_AFTER_MS = 60 * 60 * 1000 // 1 hour

export function useMasterDataSync(): void {
  const isOnline = useAppStore(s => s.isOnline)
  const isMounted = useRef(true)

  const attemptPull = useCallback(async () => {
    if (!navigator.onLine) return
    await pullMasterDataIfStale(STALE_AFTER_MS)
  }, [])

  // Pull on mount (if online and data is stale)
  useEffect(() => {
    isMounted.current = true
    void attemptPull()
    return () => { isMounted.current = false }
  }, [attemptPull])

  // Pull whenever we come back online
  useEffect(() => {
    if (isOnline) {
      void attemptPull()
    }
  }, [isOnline, attemptPull])
}

/**
 * Force a full (non-incremental) master data pull.
 * Useful in Settings page "همگام‌سازی پیکربندی" button.
 */
export function useForceMasterDataPull(): () => Promise<{ success: boolean; error?: string }> {
  return useCallback(async () => {
    const result = await pullMasterDataIfStale(0) // maxAgeMs=0 → always stale
    return { success: result.success, error: result.error }
  }, [])
}
