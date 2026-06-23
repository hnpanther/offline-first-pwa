import { useEffect, useCallback } from 'react'
import { syncManager, type SyncEvent } from '@/services/sync'
import { useAppStore } from '@/store'
import { getSettings } from '@/services/storage'

/**
 * Initializes the sync manager and wires sync events into the Zustand store.
 * Call this once at the app root level.
 */
export function useSyncManager(): void {
  const setSyncing = useAppStore(s => s.setSyncing)
  const setLastSyncAt = useAppStore(s => s.setLastSyncAt)
  const setPendingCount = useAppStore(s => s.setPendingCount)
  const setFailedCount = useAppStore(s => s.setFailedCount)
  const setSyncError = useAppStore(s => s.setSyncError)

  useEffect(() => {
    const handleEvent = (event: SyncEvent) => {
      switch (event.type) {
        case 'start':
          setSyncing(true)
          setSyncError(null)
          setPendingCount(event.pendingCount ?? 0)
          break
        case 'complete':
          setSyncing(false)
          setLastSyncAt(Date.now())
          setPendingCount(event.failedCount ?? 0)
          setFailedCount(event.failedCount ?? 0)
          break
        case 'error':
          setSyncing(false)
          setSyncError(event.error ?? 'خطا در همگام‌سازی')
          setFailedCount(event.failedCount ?? 0)
          break
        case 'progress':
          break
      }
    }

    const unsubscribe = syncManager.subscribe(handleEvent)

    // Start the sync manager after reading interval from settings
    getSettings().then(settings => {
      syncManager.start(settings.syncIntervalMs)
    })

    // Keep pending count fresh
    const refreshCount = () => {
      syncManager.getPendingCount().then(setPendingCount)
    }
    refreshCount()
    const countInterval = setInterval(refreshCount, 5_000)

    return () => {
      unsubscribe()
      clearInterval(countInterval)
      syncManager.stop()
    }
  }, [setSyncing, setLastSyncAt, setPendingCount, setFailedCount, setSyncError])
}

/** Trigger an immediate sync from any component */
export function useManualSync(): () => Promise<void> {
  return useCallback(() => syncManager.sync(), [])
}
