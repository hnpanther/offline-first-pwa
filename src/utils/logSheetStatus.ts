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

/** Local REVOKED or server message that the sheet is no longer assigned to this user. */
export function isOwnershipReassignError(syncError?: string): boolean {
  if (!syncError?.trim()) return false
  if (isRevokedSyncError(syncError)) return true
  const normalized = syncError.trim().toLowerCase()
  return (
    normalized.includes('مال شما نیست') ||
    normalized.includes('تعلق ندارد') ||
    normalized.includes('تخصیص ندارد') ||
    normalized.includes('به شما تخصیص')
  )
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

/** Undo local completion while still offline and before deadline — returns sheet to editable draft. */
export function canRevertSubmittedLogSheetToDraft(
  sheet: LogSheet,
  effectivelyOffline: boolean,
  now = Date.now()
): { ok: boolean; reason?: string } {
  if (!effectivelyOffline) {
    return { ok: false, reason: 'فقط در حالت آفلاین امکان بازگشت به پیش‌نویس وجود دارد.' }
  }
  if (sheet.status !== 'submitted') {
    return { ok: false }
  }
  if (sheet.syncStatus === 'synced') {
    return { ok: false, reason: 'این کار قبلاً به سرور ارسال شده است.' }
  }
  if (sheet.syncStatus !== 'pending') {
    return { ok: false }
  }
  if (isLogSheetExpired(sheet, now)) {
    return { ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED }
  }
  return { ok: true }
}

export function isExpiredDraft(
  sheet: Pick<LogSheet, 'status' | 'dueAt' | 'serverStatus' | 'syncError'>,
  now = Date.now()
): boolean {
  if (sheet.status !== 'draft') return false
  if (sheet.serverStatus === 'EXPIRED' || sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
    return true
  }
  return isLogSheetExpired(sheet, now)
}

/** Expiry banner on fill page — hide once the sheet is successfully synced to the server. */
export function shouldShowLogSheetExpiryAlert(sheet: LogSheet, now = Date.now()): boolean {
  if (sheet.status === 'submitted' && sheet.syncStatus === 'synced') {
    return false
  }
  if (sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
    return true
  }
  return isLogSheetExpired(sheet, now) || isExpiredDraft(sheet, now)
}

/** Submitted sheets awaiting sync stay in the active list; synced/failed go to history. */
export function isActiveLogSheet(sheet: LogSheet, now = Date.now()): boolean {
  if (isInvalidLocalLogSheet(sheet)) return false
  if (isExpiredDraft(sheet, now)) return false
  if (sheet.status === 'draft') return true
  if (sheet.status === 'submitted' && sheet.syncStatus !== 'synced') return true
  return false
}

/** Synced/failed submissions and expired local drafts belong in history. */
export function isHistoryLogSheet(sheet: LogSheet, now = Date.now()): boolean {
  if (sheet.status === 'submitted') {
    return sheet.syncStatus === 'synced' || sheet.syncStatus === 'failed'
  }
  return isExpiredDraft(sheet, now)
}

export function resolveLocalLogSheetStatusChip(
  sheet: LogSheet
): { label: string; color: 'primary' | 'warning' | 'success' | 'error' | 'default' } {
  if (sheet.status === 'submitted') {
    if (sheet.syncStatus === 'synced') {
      return { label: 'ارسال شده', color: 'success' }
    }
    if (sheet.syncStatus === 'failed') {
      return { label: 'خطا در ارسال', color: 'error' }
    }
    return { label: 'تکمیل شده — در انتظار ارسال', color: 'warning' }
  }
  if (isExpiredDraft(sheet)) {
    return { label: 'پیش‌نویس منقضی', color: 'error' }
  }
  if (isInvalidLocalLogSheet(sheet)) {
    return { label: 'غیرقابل ادامه', color: 'default' }
  }
  return { label: 'پیش‌نویس', color: 'warning' }
}
