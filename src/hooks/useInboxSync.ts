import { useCallback, useEffect } from 'react'
import { pullInbox } from '@/services/sync/pullInbox'
import { mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { pullBootstrapIfStale } from '@/services/sync/pullBootstrap'
import { saveInboxSnapshot, loadInboxSnapshot } from '@/services/storage/inboxCache'
import { useAppStore } from '@/store'
import { isTransientNetworkError } from '@/utils/networkError'
import { canReachServer } from '@/utils/connectivity'
import { t } from '@/i18n'

const BOOTSTRAP_STALE_MS = 60 * 60 * 1000

async function applyInboxSnapshot(
  setInbox: ReturnType<typeof useAppStore.getState>['setInbox']
): Promise<boolean> {
  const snap = await loadInboxSnapshot()
  if (!snap) return false
  setInbox(snap.assigned, snap.available, snap.teamOpen ?? [], snap.lastSyncAt)
  return true
}

export function useInboxSync(): {
  refreshInbox: (showLoading?: boolean) => Promise<void>
} {
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const isAuthenticated = useAppStore(s => s.authSession != null)
  const setInbox = useAppStore(s => s.setInbox)
  const setInboxLoading = useAppStore(s => s.setInboxLoading)
  const setInboxError = useAppStore(s => s.setInboxError)
  const setInboxWarning = useAppStore(s => s.setInboxWarning)

  const refreshInbox = useCallback(
    async (showLoading = false) => {
      if (!navigator.onLine || !isAuthenticated) return

      const isFirstLoad = useAppStore.getState().inboxLastSyncAt == null
      if (showLoading || isFirstLoad) setInboxLoading(true)
      setInboxError(null)
      setInboxWarning(null)

      if (isFirstLoad) {
        await applyInboxSnapshot(setInbox)
      }

      try {
        const { assigned, assignedSheets, available, teamOpen, serverTime } = await pullInbox()
        await pullBootstrapIfStale(BOOTSTRAP_STALE_MS)
        await mergeInboxIntoLocalSheets(assigned)
        const syncAt = Date.now()
        await saveInboxSnapshot({
          assigned: assignedSheets,
          available,
          teamOpen,
          lastSyncAt: syncAt,
          serverTime
        })
        setInbox(assignedSheets, available, teamOpen, syncAt)
      } catch (err) {
        const fromCache = await applyInboxSnapshot(setInbox)
        if (isTransientNetworkError(err)) {
          useAppStore.getState().setServerReachable(false)
          setInboxError(null)
          setInboxWarning(
            fromCache ? t.inbox.serverUnavailableCached : t.inbox.serverUnavailableNoCache
          )
        } else {
          setInboxWarning(null)
          setInboxError(err instanceof Error ? err.message : t.inbox.fetchFailed)
        }
      } finally {
        if (showLoading || isFirstLoad) setInboxLoading(false)
      }
    },
    [
      isAuthenticated,
      isOnline,
      serverReachable,
      setInbox,
      setInboxLoading,
      setInboxError,
      setInboxWarning
    ]
  )

  useEffect(() => {
    if (!isAuthenticated) return
    if (canReachServer(isOnline, serverReachable)) return
    void loadInboxSnapshot().then(snap => {
      if (!snap) return
      const state = useAppStore.getState()
      if (state.inboxAssigned.length > 0 || state.inboxAvailable.length > 0) return
      setInbox(snap.assigned, snap.available, snap.teamOpen ?? [], snap.lastSyncAt)
    })
  }, [isAuthenticated, isOnline, serverReachable, setInbox])

  useEffect(() => {
    if (isAuthenticated && navigator.onLine) {
      void refreshInbox(false)
    }
  }, [isAuthenticated, isOnline, refreshInbox])

  return { refreshInbox }
}
