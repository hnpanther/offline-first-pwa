import { useCallback, useEffect } from 'react'
import { pullInbox } from '@/services/sync/pullInbox'
import { mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { pullMasterDataIfStale } from '@/services/sync/pullMasterData'
import { saveInboxSnapshot, loadInboxSnapshot } from '@/services/storage/inboxCache'
import { useAppStore } from '@/store'

const MASTER_DATA_STALE_MS = 60 * 60 * 1000

export function useInboxSync(): {
  refreshInbox: (showLoading?: boolean) => Promise<void>
} {
  const isOnline = useAppStore(s => s.isOnline)
  const isAuthenticated = useAppStore(s => s.authSession != null)
  const setInbox = useAppStore(s => s.setInbox)
  const setInboxLoading = useAppStore(s => s.setInboxLoading)
  const setInboxError = useAppStore(s => s.setInboxError)

  const refreshInbox = useCallback(
    async (showLoading = false) => {
      if (!navigator.onLine || !isAuthenticated) return
      const isFirstLoad = useAppStore.getState().inboxLastSyncAt == null
      if (showLoading || isFirstLoad) setInboxLoading(true)
      setInboxError(null)
      try {
        const { assigned, available, teamOpen, serverTime } = await pullInbox()
        // Asset entries are built from master data — refresh config before provisioning.
        await pullMasterDataIfStale(MASTER_DATA_STALE_MS)
        await mergeInboxIntoLocalSheets(assigned)
        const syncAt = Date.now()
        await saveInboxSnapshot({
          assigned,
          available,
          teamOpen,
          lastSyncAt: syncAt,
          serverTime
        })
        setInbox(assigned, available, teamOpen, syncAt)
      } catch (err) {
        setInboxError(err instanceof Error ? err.message : 'خطا در دریافت کارتابل')
      } finally {
        if (showLoading || isFirstLoad) setInboxLoading(false)
      }
    },
    [isAuthenticated, setInbox, setInboxLoading, setInboxError]
  )

  // Restore last inbox when offline (read-only snapshot)
  useEffect(() => {
    if (!isAuthenticated || isOnline) return
    void loadInboxSnapshot().then(snap => {
      if (!snap) return
      const state = useAppStore.getState()
      if (state.inboxLastSyncAt != null) return
      setInbox(snap.assigned, snap.available, snap.teamOpen ?? [], snap.lastSyncAt)
    })
  }, [isAuthenticated, isOnline, setInbox])

  useEffect(() => {
    if (isOnline && isAuthenticated) {
      void refreshInbox(false)
    }
  }, [isOnline, isAuthenticated, refreshInbox])

  return { refreshInbox }
}
