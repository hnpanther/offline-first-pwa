import type { LogSheet } from '@/types'
import { parseArchivedLogSheetViewId } from '@/services/storage/logSheetArchive'

export const SYNC_OUTCOME_MESSAGES = {
  EXPIRED: 'مهلت تکمیل این کار گذشته است و امکان سینک وجود ندارد.',
  REVOKED: 'این کار دیگر به شما تعلق ندارد و قابل ادامه نیست.',
  REASSIGNED: 'این کار به اپراتور دیگری واگذار شده است.',
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
  if (sheet.serverStatus === 'EXPIRED') return true

  if (sheet.status === 'submitted') {
    const completedAt = sheet.completedAt ?? sheet.submittedAt
    if (completedAt != null && sheet.dueAt != null) {
      // On-time offline completion stays sync-eligible even after wall-clock dueAt passes.
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

export function isReassignedSyncError(syncError?: string): boolean {
  if (!syncError) return false
  return syncError === SYNC_OUTCOME_MESSAGES.REASSIGNED
}

/** Work removed from assignee (supervisor release/reassign or shared-tablet block). */
export function isRevokedAssignment(
  sheet: Pick<LogSheet, 'status' | 'syncStatus' | 'syncError'>
): boolean {
  return sheet.syncStatus === 'failed' && isRevokedSyncError(sheet.syncError)
}

/** Only truly terminal states — revoked assignments may return after supervisor reassign. */
export function isInvalidLocalLogSheet(sheet: Pick<LogSheet, 'syncError'>): boolean {
  return isSupersededSyncError(sheet.syncError)
}

/** Local REVOKED or server message that the sheet is no longer assigned to this user. */
export function isOwnershipReassignError(syncError?: string): boolean {
  if (!syncError?.trim()) return false
  if (isRevokedSyncError(syncError)) return true
  const normalized = syncError.trim().toLowerCase()
  return (
    normalized.includes('مال شما نیست') ||
    normalized.includes('تعلق ندارد') ||
    normalized.includes('متعلق به') ||
    normalized.includes('کاربر لاگین') ||
    normalized.includes('تخصیص ندارد') ||
    normalized.includes('به شما تخصیص') ||
    normalized.includes('not assigned') ||
    normalized.includes('not yours')
  )
}

/** Normalize server ownership failures for consistent local handling. */
export function normalizeLogSheetSyncError(
  outcome: string | undefined,
  error?: string | null
): string {
  const message = syncOutcomeMessage(outcome, error)
  if (outcome === 'SUPERSEDED' || outcome === 'EXPIRED') {
    return message
  }
  if (isOwnershipReassignError(message)) {
    return SYNC_OUTCOME_MESSAGES.REVOKED
  }
  return message
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

/** Submitted sheets awaiting sync stay in the active list; revoked assignments go to history. */
export function isActiveLogSheet(sheet: LogSheet, now = Date.now()): boolean {
  if (parseArchivedLogSheetViewId(sheet.localId)) return false
  if (isInvalidLocalLogSheet(sheet)) return false
  if (isRevokedAssignment(sheet)) return false
  if (isExpiredDraft(sheet, now)) return false
  if (sheet.status === 'draft') return true
  if (sheet.status === 'submitted' && sheet.syncStatus !== 'synced') return true
  return false
}

/** Archived snapshot from a shared-tablet user switch (read-only history). */
export function isArchivedSessionSnapshot(sheet: Pick<LogSheet, 'localId'>): boolean {
  return parseArchivedLogSheetViewId(sheet.localId) != null
}

/** Work blocked because supervisor reassigned / shared-tablet handoff. */
export function isReassignedAwayFromUser(
  sheet: Pick<LogSheet, 'localId' | 'status' | 'syncStatus' | 'syncError'>
): boolean {
  if (isArchivedSessionSnapshot(sheet)) return true
  if (isRevokedAssignment(sheet)) return true
  return sheet.syncStatus === 'failed' && isReassignedSyncError(sheet.syncError)
}

/** Synced/failed submissions, revoked work, archived snapshots, and expired local drafts belong in history. */
export function isHistoryLogSheet(sheet: LogSheet, now = Date.now()): boolean {
  if (isArchivedSessionSnapshot(sheet)) return true
  if (isRevokedAssignment(sheet)) return true
  if (sheet.status === 'submitted') {
    return sheet.syncStatus === 'synced' || sheet.syncStatus === 'failed'
  }
  return isExpiredDraft(sheet, now)
}

export function resolveLocalLogSheetStatusChip(
  sheet: LogSheet
): { label: string; color: 'primary' | 'warning' | 'success' | 'error' | 'default' } {
  if (isReassignedAwayFromUser(sheet)) {
    return { label: 'واگذار شده به اپراتور دیگر', color: 'warning' }
  }
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
