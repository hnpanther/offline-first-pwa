import { useCallback, useEffect } from 'react'
import { pullInbox } from '@/services/sync/pullInbox'
import { ensureSessionUserId } from '@/services/auth/sessionContext'
import { mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { syncManager } from '@/services/sync'
import { pullBootstrapIfStale } from '@/services/sync/pullBootstrap'
import { saveInboxSnapshot, loadInboxSnapshot } from '@/services/storage/inboxCache'
import { useAppStore } from '@/store'
import { isTransientNetworkError } from '@/utils/networkError'
import { canReachServer } from '@/utils/connectivity'
import { t } from '@/i18n'

const BOOTSTRAP_STALE_MS = 60 * 60 * 1000

type SetInbox = ReturnType<typeof useAppStore.getState>['setInbox']

async function applyInboxSnapshot(setInbox: SetInbox): Promise<boolean> {
  const snap = await loadInboxSnapshot()
  if (!snap) return false
  setInbox(snap.assigned, snap.available, snap.teamOpen ?? [], snap.lastSyncAt)
  return true
}

/**
 * Pull inbox from server, merge into local sheets, and update store snapshot.
 *
 * The merge is skipped entirely when the session has no resolved user id.
 * `shouldPreserveLocalFormData` returns false for a null id, so merging in that state would
 * treat every local sheet as somebody else's and overwrite the operator's typed values with
 * the server's empty ones. Displaying the lists is still safe — they are read-only — so the
 * app stays usable while the binding heals.
 */
export async function pullAndMergeInbox(setInbox: SetInbox): Promise<void> {
  const { assigned, assignedSheets, available, teamOpen, serverTime } = await pullInbox()
  await pullBootstrapIfStale(BOOTSTRAP_STALE_MS)

  const sessionUserId = await ensureSessionUserId()
  if (sessionUserId) {
    await mergeInboxIntoLocalSheets(assigned)
  }
  const syncAt = Date.now()
  await saveInboxSnapshot({
    assigned: assignedSheets,
    available,
    teamOpen,
    lastSyncAt: syncAt,
    serverTime
  })
  setInbox(assignedSheets, available, teamOpen, syncAt)
}

export function useInboxSync(): {
  refreshInbox: (showLoading?: boolean, skipPostSync?: boolean) => Promise<void>
} {
  const isOnline = useAppStore(s => s.isOnline)
  const serverReachable = useAppStore(s => s.serverReachable)
  const isAuthenticated = useAppStore(s => s.authSession != null)
  const setInbox = useAppStore(s => s.setInbox)
  const setInboxLoading = useAppStore(s => s.setInboxLoading)
  const setInboxError = useAppStore(s => s.setInboxError)
  const setInboxWarning = useAppStore(s => s.setInboxWarning)

  const refreshInbox = useCallback(
    async (showLoading = false, skipPostSync = false) => {
      if (!navigator.onLine || !isAuthenticated) return

      const isFirstLoad = useAppStore.getState().inboxLastSyncAt == null
      if (showLoading || isFirstLoad) setInboxLoading(true)
      setInboxError(null)
      setInboxWarning(null)

      if (isFirstLoad) {
        await applyInboxSnapshot(setInbox)
      }

      try {
        await pullAndMergeInbox(setInbox)
        if (!skipPostSync) {
          await syncManager.sync()
        }
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
    // `isOnline` and `serverReachable` are listed on purpose even though the body reads them
    // through the store rather than the closure. They are what should make this callback new
    // when connectivity changes, and the effects downstream key off its identity. Trimming them
    // is the kind of "unnecessary dependency" cleanup that silently stops an inbox refreshing
    // on reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
