import type { FormSubmissionServerStatus, LocalFormSubmission } from '@/types'

/**
 * Active vs history for ad-hoc forms — the same split as log sheets.
 *
 * Active: a draft still being filled, or a final the server has not accepted yet.
 * History: a filing the server holds as submitted, approved or voided, plus a final the
 * server refused (kept on the device, same as a failed round).
 */

export function isActiveFormSubmission(
  row: Pick<LocalFormSubmission, 'status' | 'syncStatus'>
): boolean {
  if (row.status === 'draft') return true
  return row.status === 'submitted' && row.syncStatus !== 'synced' && row.syncStatus !== 'failed'
}

export function isHistoryFormSubmission(
  row: Pick<LocalFormSubmission, 'status' | 'syncStatus' | 'serverStatus'>
): boolean {
  if (isActiveFormSubmission(row)) return false
  if (row.serverStatus === 'SUBMITTED' || row.serverStatus === 'APPROVED' || row.serverStatus === 'VOIDED') {
    return true
  }
  return row.status === 'submitted' && (row.syncStatus === 'synced' || row.syncStatus === 'failed')
}

export function isTerminalFormServerStatus(
  status?: FormSubmissionServerStatus | string | null
): boolean {
  return status === 'SUBMITTED' || status === 'APPROVED' || status === 'VOIDED'
}

/**
 * Local work the history merge must not overwrite: an open draft with edits, or a final
 * still waiting for the server. A delivered row may take the server's later review status.
 */
export function formHistoryMustKeepLocal(
  row: Pick<LocalFormSubmission, 'status' | 'syncStatus' | 'locallyEditedAt' | 'draftSyncedAt'>
): boolean {
  if (row.status === 'draft' && row.locallyEditedAt != null &&
      (row.draftSyncedAt == null || row.locallyEditedAt > row.draftSyncedAt)) return true
  if (row.status === 'submitted' && row.syncStatus !== 'synced') return true
  return false
}
