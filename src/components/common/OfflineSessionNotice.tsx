import { Alert } from '@mui/material'
import { t } from '@/i18n'
import { formatJalaliDateTime } from '@/utils/formatDate'
import type { OfflineSessionVerdict } from '@/services/auth/offlineSession'

/**
 * Says, before it happens, that the offline-session ceiling (backend V28) is about to lock the app —
 * so an operator in a dead zone can walk back into coverage, or finish and save, instead of meeting
 * the login screen without warning. Shown within 12 hours of the lock, or within a quarter of the
 * ceiling when that is shorter. The time is the server's — the one the lock is decided on.
 */
export function OfflineSessionNotice({ verdict }: { verdict: OfflineSessionVerdict }) {
  if (verdict.locked || !verdict.warn || verdict.lockAt == null) return null
  return (
    <Alert severity="warning" sx={{ mb: 2 }} data-testid="offline-session-notice">
      {t.auth.offlineLockSoon(formatJalaliDateTime(verdict.lockAt))}
    </Alert>
  )
}
