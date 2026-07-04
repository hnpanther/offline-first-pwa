import { useCallback, useEffect } from 'react'
import { pullInbox } from '@/services/sync/pullInbox'
import { mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { useAppStore } from '@/store'

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
        const { assigned, available } = await pullInbox()
        await mergeInboxIntoLocalSheets(assigned)
        setInbox(assigned, available, Date.now())
      } catch (err) {
        setInboxError(err instanceof Error ? err.message : 'خطا در دریافت کارتابل')
      } finally {
        if (showLoading || isFirstLoad) setInboxLoading(false)
      }
    },
    [isAuthenticated, setInbox, setInboxLoading, setInboxError]
  )

  useEffect(() => {
    if (isOnline && isAuthenticated) {
      void refreshInbox(false)
    }
  }, [isOnline, isAuthenticated, refreshInbox])

  return { refreshInbox }
}
