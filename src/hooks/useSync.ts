import { useEffect, useCallback } from 'react'
import { syncManager, type SyncEvent } from '@/services/sync'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import { expireLookups } from '@/services/lookups/lookupStore'
import { pullAndMergeInbox } from '@/hooks/useInboxSync'
import { useAppStore } from '@/store'
import { getSettings } from '@/services/storage'

export function useSyncManager(): void {
  const setSyncing = useAppStore(s => s.setSyncing)
  const setLastSyncAt = useAppStore(s => s.setLastSyncAt)
  const setPendingCount = useAppStore(s => s.setPendingCount)
  const setFailedCount = useAppStore(s => s.setFailedCount)
  const setSyncError = useAppStore(s => s.setSyncError)
  const isOnline = useAppStore(s => s.isOnline)
  const authSession = useAppStore(s => s.authSession)

  // Reference lists whose lease ended go now, online or not: the lease exists precisely for the
  // tablet that stays offline (backend roadmap §31). A field reading the store also deletes an
  // expired copy the moment it looks; this covers the device nobody opens a lookup field on.
  useEffect(() => {
    void expireLookups().catch(() => {})
  }, [authSession])

  useEffect(() => {
    if (!isOnline || !authSession) return
    void cleanupLocalLogSheets().then(() => {
      setLastSyncAt(Date.now())
    })
  }, [isOnline, authSession, setLastSyncAt])

  useEffect(() => {
    const handleEvent = (event: SyncEvent) => {
      switch (event.type) {
        case 'start':
          setSyncing(true)
          if (!event.transient) setSyncError(null)
          if (event.pendingCount != null) setPendingCount(event.pendingCount)
          break
        case 'complete':
          setSyncing(false)
          setLastSyncAt(Date.now())
          setFailedCount(event.failedCount ?? 0)
          void syncManager.getPendingCount().then(setPendingCount)
          if ((event.syncedCount ?? 0) > 0 && navigator.onLine) {
            void pullAndMergeInbox(useAppStore.getState().setInbox).catch(() => {})
          }
          break
        case 'error':
          setSyncing(false)
          if (event.transient) {
            setSyncError(null)
          } else {
            setSyncError(event.error ?? 'خطا در همگام‌سازی')
          }
          setFailedCount(event.failedCount ?? 0)
          if (event.pendingCount != null) {
            setPendingCount(event.pendingCount)
          } else {
            void syncManager.getPendingCount().then(setPendingCount)
          }
          break
        case 'progress':
          if (event.pendingCount != null) setPendingCount(event.pendingCount)
          break
      }
    }

    const unsubscribe = syncManager.subscribe(handleEvent)

    getSettings().then(settings => {
      syncManager.start(settings.syncIntervalMs)
    })

    const refreshCount = () => {
      syncManager.getPendingCount().then(setPendingCount)
    }
    refreshCount()
    const countInterval = setInterval(refreshCount, 15_000)

    return () => {
      unsubscribe()
      clearInterval(countInterval)
      syncManager.stop()
    }
  }, [setSyncing, setLastSyncAt, setPendingCount, setFailedCount, setSyncError])
}

export function useManualSync(): () => Promise<void> {
  return useCallback(() => syncManager.sync(), [])
}
