import { isCompletedServerStatus, type LogSheet } from '@/types'
import type { FieldDefinition } from '@/types/sync'
import {
  describeSubmitBlockingIssues,
  findSubmitBlockingIssues
} from '@/utils/formDataValidation'
import { parseArchivedLogSheetViewId } from '@/services/storage/logSheetArchive'

export const SYNC_OUTCOME_MESSAGES = {
  EXPIRED: 'مهلت تکمیل این کار گذشته است و امکان سینک وجود ندارد.',
  CANCELLED: 'این کار توسط سرپرست لغو شده است.',
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

/** Server-authoritative cancellation — unlike expiry, this is never derived from dueAt. */
export function isLogSheetCancelled(sheet: Pick<LogSheet, 'serverStatus'>): boolean {
  return sheet.serverStatus === 'CANCELLED'
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

/**
 * A submitted-but-not-synced sheet whose server sheet is already SUBMITTED (by someone else —
 * a genuinely-synced-by-this-device sheet would have `syncStatus: 'synced'`, not 'failed').
 * This structural check — not a `syncError` text match — is the reliable signal: the stored
 * `syncError` is the backend's own translated message (see `ApiResponseSupport.localize` /
 * `ErrorTranslator` on the server), which does not equal this client's own
 * `SYNC_OUTCOME_MESSAGES` strings (different wording on each side), so comparing against them
 * silently never matches for a real backend-reported outcome. The text check below is kept only
 * as a fallback for any legacy/purely-local syncError that might still carry the old constant.
 */
export function isSupersededSyncError(
  sheet: Pick<LogSheet, 'status' | 'syncStatus' | 'serverStatus' | 'syncError'>
): boolean {
  if (sheet.status === 'submitted' && sheet.syncStatus === 'failed'
      && isCompletedServerStatus(sheet.serverStatus)) {
    return true
  }
  const syncError = sheet.syncError
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
export function isInvalidLocalLogSheet(
  sheet: Pick<LogSheet, 'status' | 'syncStatus' | 'serverStatus' | 'syncError'>
): boolean {
  return isSupersededSyncError(sheet)
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
  if (outcome === 'SUPERSEDED' || outcome === 'EXPIRED' || outcome === 'CANCELLED') {
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
    case 'CANCELLED':
      return SYNC_OUTCOME_MESSAGES.CANCELLED
    case 'DUPLICATE':
      return SYNC_OUTCOME_MESSAGES.DUPLICATE
    default:
      return SYNC_OUTCOME_MESSAGES.ERROR
  }
}

/**
 * The server rejected this submission for bad field values — the one rejection an operator can
 * actually fix, by editing them.
 *
 * The other three rejections (missing server id, sheet deleted server-side, asset mismatch) are
 * not operator-fixable and deliberately do not unlock the correction path.
 */
export function failedOnFieldValidation(
  sheet: Pick<LogSheet, 'syncStatus' | 'lastSubmitOutcome'>
): boolean {
  return sheet.syncStatus === 'failed' && sheet.lastSubmitOutcome === 'VALIDATION_ERROR'
}

/**
 * @param fallbackDefs field definitions from the shared per-class table, used only for sheets
 *        stored before sheets carried their own. Omitting it never blocks anything — a class
 *        with no resolvable schema is left to the server.
 */
export function canSubmitLogSheet(
  sheet: LogSheet,
  now = Date.now(),
  fallbackDefs: FieldDefinition[] = []
): { ok: boolean; reason?: string } {
  if (isLogSheetCancelled(sheet)) {
    return { ok: false, reason: SYNC_OUTCOME_MESSAGES.CANCELLED }
  }
  if (isLogSheetExpired(sheet, now)) {
    return { ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED }
  }
  if (isCompletedServerStatus(sheet.serverStatus) && sheet.syncStatus === 'synced') {
    return { ok: false, reason: 'این کار قبلاً ثبت نهایی شده است.' }
  }

  // Prevention, and the whole point of this gate: without it an operator could submit a sheet
  // the server was certain to reject, then be left at the equipment reading a validation error
  // with no action available. Refusing here happens while they are still on the form.
  //
  // Conservative by construction — see findSubmitBlockingIssues. It only reports fields it can
  // prove the server would reject, so it cannot strand someone over data this device lacks.
  const issues = findSubmitBlockingIssues(sheet, fallbackDefs)
  if (issues.length > 0) {
    return { ok: false, reason: describeSubmitBlockingIssues(issues) }
  }

  return { ok: true }
}

/** Undo local completion while still offline and before deadline — returns sheet to editable draft. */
export function canRevertSubmittedLogSheetToDraft(
  sheet: LogSheet,
  effectivelyOffline: boolean,
  now = Date.now()
): { ok: boolean; reason?: string } {
  if (sheet.status !== 'submitted') {
    return { ok: false }
  }

  // The correction path. A sheet the server rejected for bad values is a different situation
  // from an unsent completion: the work is stuck, and re-sending the identical payload would
  // only earn the identical refusal. Editing and resubmitting is legitimate precisely because
  // the data changes — so this case is allowed online, and from 'failed' rather than 'pending'.
  //
  // The expiry check below still applies: a sheet past its deadline cannot be resubmitted by
  // anyone, and offering the edit would only waste the operator's time.
  if (failedOnFieldValidation(sheet)) {
    if (isLogSheetExpired(sheet, now)) {
      return { ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED }
    }
    if (isLogSheetCancelled(sheet)) {
      return { ok: false, reason: SYNC_OUTCOME_MESSAGES.CANCELLED }
    }
    return { ok: true }
  }

  if (!effectivelyOffline) {
    return { ok: false, reason: 'فقط در حالت آفلاین امکان بازگشت به پیش‌نویس وجود دارد.' }
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

/**
 * A completion this device already delivered, which a supervisor has since **reopened**
 * (`POST /log-sheets/{id}/reopen`) with a new future deadline.
 *
 * The server moves such a sheet back to `IN_PROGRESS` (or `ASSIGNED`), clears its submission
 * timestamps and keeps the entry values, so it returns to this operator's assigned inbox and
 * the ordinary inbox merge writes the fresh `serverStatus`/`dueAt` onto the local row — while
 * `status`/`syncStatus` stay `submitted`/`synced`, because the local completion really was
 * delivered. That otherwise-impossible combination is exactly the signal: a sheet the device
 * completed and synced cannot be open on the server again for any other reason.
 *
 * Note this is only a *candidate* marker for the UI. The row is never reopened locally on the
 * strength of it — `canContinueReopenedLogSheet` re-checks against a freshly fetched bundle
 * first, because the inbox response that set these fields may have been read from the server
 * moments *before* this device's own submission landed.
 *
 * `PENDING` is deliberately excluded: a reopen with no assignee sends the sheet back to the
 * pool, where it must be claimed like any other pool work rather than silently resumed.
 * Archived snapshots are excluded too — they are read-only history of a shared tablet.
 */
export function isReopenedAfterSync(
  sheet: Pick<LogSheet, 'localId' | 'status' | 'syncStatus' | 'serverStatus' | 'dueAt'>,
  now = Date.now()
): boolean {
  if (isArchivedSessionSnapshot(sheet)) return false
  if (sheet.status !== 'submitted' || sheet.syncStatus !== 'synced') return false
  if (sheet.serverStatus !== 'IN_PROGRESS' && sheet.serverStatus !== 'ASSIGNED') return false
  return sheet.dueAt != null && sheet.dueAt > now
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

/** A local draft whose server sheet was cancelled by a supervisor before the operator submitted it. */
export function isCancelledDraft(sheet: Pick<LogSheet, 'status' | 'serverStatus' | 'syncError'>): boolean {
  if (sheet.status !== 'draft') return false
  return sheet.serverStatus === 'CANCELLED' || sheet.syncError === SYNC_OUTCOME_MESSAGES.CANCELLED
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
  if (isCancelledDraft(sheet)) return false
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
  if (isArchivedSessionSnapshot(sheet)) {
    return isRevokedAssignment(sheet) || isReassignedSyncError(sheet.syncError)
  }
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
  return isExpiredDraft(sheet, now) || isCancelledDraft(sheet)
}

export function resolveLocalLogSheetStatusChip(
  sheet: LogSheet
): { label: string; color: 'primary' | 'warning' | 'success' | 'error' | 'default' } {
  // Synced completion wins over any stale revoke/reassign flag.
  if (sheet.status === 'submitted' && sheet.syncStatus === 'synced') {
    // …unless the supervisor reopened it. Without this the card keeps reading "ارسال شده"
    // in History and nothing tells the operator the work is theirs to finish again — the
    // fill page's continue action would never be found.
    if (isReopenedAfterSync(sheet)) {
      return { label: 'بازگشایی شده — قابل ادامه', color: 'warning' }
    }
    return { label: 'ارسال شده', color: 'success' }
  }
  // Checked regardless of local status (draft or already-submitted-but-not-yet-synced) — a
  // supervisor cancel can arrive after the operator already tapped "submit" locally.
  if (isLogSheetCancelled(sheet)) {
    return { label: 'لغو شده توسط سرپرست', color: 'error' }
  }
  if (isReassignedAwayFromUser(sheet)) {
    return { label: 'واگذار شده به اپراتور دیگر', color: 'warning' }
  }
  if (sheet.status === 'submitted') {
    if (sheet.syncStatus === 'failed') {
      return { label: 'خطا در ارسال', color: 'error' }
    }
    return { label: 'تکمیل شده — در انتظار ارسال', color: 'warning' }
  }
  if (isExpiredDraft(sheet)) {
    return { label: 'پیش‌نویس منقضی', color: 'error' }
  }
  if (isCancelledDraft(sheet)) {
    return { label: 'لغو شده توسط سرپرست', color: 'error' }
  }
  if (isInvalidLocalLogSheet(sheet)) {
    return { label: 'غیرقابل ادامه', color: 'default' }
  }
  return { label: 'پیش‌نویس', color: 'warning' }
}
