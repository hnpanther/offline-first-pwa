/**
 * Which rounds on this tablet hold readings the server has received in **no form at all** —
 * neither applied to the round nor kept for a supervisor to review (backend V25).
 *
 * One definition, used by four readers that must agree: the dashboard's «ارسال‌نشده» card, the
 * device-check page, the report this tablet sends to the panel («نشست‌های اپ موبایل») — and the
 * local purge (`isEligibleForLocalPurge`, issue P-05), which never deletes a round this says is
 * undelivered, whatever the server's retention settings are.
 *
 * Not counted, deliberately:
 * - a submitted round still waiting to sync — that is the pending queue («در انتظار ارسال»), which
 *   drains by itself;
 * - an active draft that is still open — its readings travel as ordinary progress;
 * - a round the server refused but **kept**: `serverKeptAt` (V25), or a `SUPERSEDED`/`CANCELLED`
 *   outcome, which the server has kept as a void submission since V14 — unless it said
 *   `kept: false` (`serverKeepRefusedAt`, V26), the one case where it declined;
 * - a draft whose late readings the server kept (`lateProgressKeptMarker`) and which has not been
 *   edited since.
 */

import type { LogSheet } from '@/types'
import {
  isArchivedSessionSnapshot,
  isInvalidLocalLogSheet,
  isLogSheetCancelled,
  isLogSheetExpired,
  isRevokedAssignment
} from '@/utils/logSheetStatus'

/** Outcomes the server has always answered after keeping the payload as a void submission. */
const KEPT_BY_SERVER_OUTCOMES = new Set(['SUPERSEDED', 'CANCELLED'])

/** The newest local edit marker on this round — an asset's or the round's own answers. */
export function latestEditMarker(
  sheet: Pick<LogSheet, 'entries' | 'sheetFormLocallyEditedAt'>
): number | undefined {
  let latest: number | undefined = sheet.sheetFormLocallyEditedAt ?? undefined
  for (const entry of sheet.entries ?? []) {
    const marker = entry.locallyEditedAt
    if (marker != null && (latest == null || marker > latest)) latest = marker
  }
  return latest
}

/**
 * Whether an expired draft still owes the server a late-progress push (P-01): it has local edits,
 * and none of them has been answered yet. "Answered" is either way — kept, or refused by a server
 * older than V25 — so each state of the markers is sent exactly once, and a newer edit sends again.
 */
export function isLateProgressDue(
  sheet: Pick<LogSheet, 'entries' | 'sheetFormLocallyEditedAt' | 'lateProgressSentMarker'>
): boolean {
  const marker = latestEditMarker(sheet)
  if (marker == null) return false
  return sheet.lateProgressSentMarker == null || marker > sheet.lateProgressSentMarker
}

/**
 * Whether the server holds the readings of a completion it refused: it said `kept: true`, or the
 * outcome is one it has always kept — unless it said `kept: false`, which overrides the outcome.
 */
export function isRefusalHeldByServer(
  sheet: Pick<LogSheet, 'serverKeptAt' | 'serverKeepRefusedAt' | 'lastSubmitOutcome'>
): boolean {
  if (sheet.serverKeptAt != null) return true
  if (sheet.serverKeepRefusedAt != null) return false
  return sheet.lastSubmitOutcome != null && KEPT_BY_SERVER_OUTCOMES.has(sheet.lastSubmitOutcome)
}

export function isUndeliveredRound(sheet: LogSheet, now = Date.now()): boolean {
  if (isArchivedSessionSnapshot(sheet)) return false

  if (sheet.status === 'submitted') {
    // Synced is delivered; pending/syncing is the queue, still on its way.
    if (sheet.syncStatus !== 'failed') return false
    return !isRefusalHeldByServer(sheet)
  }

  // A draft: undelivered only if it has edits of its own that can no longer travel as ordinary
  // progress — and that the server has not kept as late progress.
  const marker = latestEditMarker(sheet)
  if (marker == null) return false
  if (sheet.lateProgressKeptMarker != null && sheet.lateProgressKeptMarker >= marker) return false
  return (
    isLogSheetExpired(sheet, now) ||
    isLogSheetCancelled(sheet) ||
    isRevokedAssignment(sheet) ||
    isInvalidLocalLogSheet(sheet)
  )
}

/** When the round was last worked on, for "the oldest undelivered round". */
function undeliveredSince(sheet: LogSheet): number {
  if (sheet.status === 'submitted') {
    return sheet.completedAt ?? sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
  }
  return latestEditMarker(sheet) ?? sheet.updatedAt ?? sheet.createdAt
}

export interface UndeliveredBacklog {
  count: number
  /** Device time; null when there are none. */
  oldestAt: number | null
}

export function computeUndeliveredBacklog(sheets: LogSheet[], now = Date.now()): UndeliveredBacklog {
  let count = 0
  let oldestAt: number | null = null
  for (const sheet of sheets) {
    if (!isUndeliveredRound(sheet, now)) continue
    count++
    const since = undeliveredSince(sheet)
    if (oldestAt == null || since < oldestAt) oldestAt = since
  }
  return { count, oldestAt }
}
