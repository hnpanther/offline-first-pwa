import { Alert } from '@mui/material'
import { useAppStore } from '@/store'
import { t } from '@/i18n'

/**
 * Tells the operator that sync is deliberately paused, not broken.
 *
 * Raised when login succeeded but the bootstrap call that resolves `sessionUserId` did not.
 * Without this the app would look completely healthy while silently pushing nothing — which is
 * exactly the failure mode that made the original bug so hard to notice. Local work stays
 * usable throughout; the binding retries on every sync tick and inbox refresh and this clears
 * itself the moment it succeeds.
 */
export function SessionBindingNotice() {
  const pending = useAppStore(s => s.sessionBindingPending)
  const authSession = useAppStore(s => s.authSession)
  if (!pending || !authSession) return null

  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      {t.auth.bindingPending}
    </Alert>
  )
}
