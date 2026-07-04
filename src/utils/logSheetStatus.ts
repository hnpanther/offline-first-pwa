import type { LogSheet } from '@/types'

export const SYNC_OUTCOME_MESSAGES = {
  EXPIRED: 'مهلت تکمیل این کار گذشته است و امکان سینک وجود ندارد.',
  REVOKED: 'این کار دیگر به شما تعلق ندارد و قابل ادامه نیست.',
  SUPERSEDED: 'این کار قبلاً توسط شخص دیگری ثبت شده و مورد شما قابل سینک نیست.',
  DUPLICATE: 'این ارسال قبلاً ثبت شده است.',
  ERROR: 'خطا در ارسال به سرور.'
} as const

export function isLogSheetExpired(sheet: Pick<LogSheet, 'dueAt' | 'serverStatus'>, now = Date.now()): boolean {
  if (sheet.serverStatus === 'EXPIRED') return true
  return sheet.dueAt != null && sheet.dueAt <= now
}

/** Device completion time vs deadline (for offline submit / late sync). */
export function completedWithinDeadline(
  sheet: Pick<LogSheet, 'dueAt' | 'completedAt' | 'submittedAt'>
): boolean {
  const completedAt = sheet.completedAt ?? sheet.submittedAt
  if (sheet.dueAt == null || completedAt == null) return false
  return completedAt <= sheet.dueAt
}

/**
 * Expiry check for outbound sync: uses device completion time when the sheet
 * was already submitted locally, not the (possibly late) online time.
 */
export function isLogSheetExpiredForSync(
  sheet: Pick<LogSheet, 'dueAt' | 'serverStatus' | 'status' | 'completedAt' | 'submittedAt'>,
  now = Date.now()
): boolean {
  if (sheet.status === 'submitted') {
    const completedAt = sheet.completedAt ?? sheet.submittedAt
    if (completedAt != null && sheet.dueAt != null) {
      return completedAt > sheet.dueAt
    }
  }
  return isLogSheetExpired(sheet, now)
}

export function isSupersededSyncError(syncError?: string): boolean {
  if (!syncError) return false
  return syncError.includes('SUPERSEDED') || syncError === SYNC_OUTCOME_MESSAGES.SUPERSEDED
}

export function isRevokedSyncError(syncError?: string): boolean {
  if (!syncError) return false
  return syncError === SYNC_OUTCOME_MESSAGES.REVOKED
}

export function isInvalidLocalLogSheet(sheet: Pick<LogSheet, 'syncError'>): boolean {
  return isSupersededSyncError(sheet.syncError) || isRevokedSyncError(sheet.syncError)
}

export function syncOutcomeMessage(outcome?: string, error?: string | null): string {
  if (error?.trim()) return error
  switch (outcome) {
    case 'SUPERSEDED':
      return SYNC_OUTCOME_MESSAGES.SUPERSEDED
    case 'EXPIRED':
      return SYNC_OUTCOME_MESSAGES.EXPIRED
    case 'DUPLICATE':
      return SYNC_OUTCOME_MESSAGES.DUPLICATE
    default:
      return SYNC_OUTCOME_MESSAGES.ERROR
  }
}

export function canSubmitLogSheet(sheet: LogSheet, now = Date.now()): { ok: boolean; reason?: string } {
  if (isLogSheetExpired(sheet, now)) {
    return { ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED }
  }
  if (sheet.serverStatus === 'SUBMITTED' && sheet.syncStatus === 'synced') {
    return { ok: false, reason: 'این کار قبلاً ثبت نهایی شده است.' }
  }
  return { ok: true }
}
