import {
  pushLogSheetProgressBatch,
  type LogSheetProgressItem,
  type LogSheetProgressResult
} from '@/services/api'
import { getAllLogSheets, getLogSheet, updateLogSheet } from '@/services/storage'
import { getSessionUserId } from '@/services/auth/sessionContext'
import {
  isInvalidLocalLogSheet,
  isLogSheetCancelled,
  isLogSheetExpired,
  isRevokedAssignment
} from '@/utils/logSheetStatus'
import { resolveLocalWorkOwner } from '@/utils/logSheetLocalData'
import { toIdString } from '@/utils/ids'
import type { LogSheet, LogSheetEntryData } from '@/types'

/**
 * Reporting how far a round has got, while it is still being walked.
 *
 * **Why this exists.** The device pushed completions and nothing else, so a round was invisible
 * to the server for its whole duration: an operator could fill twenty assets in the first hour,
 * be online throughout, and a supervisor looking at the sheet saw no data at all. If the sheet
 * then changed hands the next operator started from an empty form and re-walked ground already
 * covered.
 *
 * **It is a separate queue from the submit batch, and that is the design.**
 *
 * - *Different meaning.* A submit delivers work the operator has finished and must never be lost.
 *   A progress push is a live report about work in progress; if it fails, nothing is lost —
 *   the readings are still on the device and still deliverable.
 * - *Different failure handling.* Nothing here may write `status`, `syncStatus` or `syncError`.
 *   Those belong to the submit path, and a refused progress push writing them is how real,
 *   undelivered work would end up marked failed.
 * - *Different payload.* A submit resends every asset, so the delivered round is self-contained.
 *   A progress push sends **only what changed**, so its cost is proportional to work actually
 *   done rather than to the size of the sheet times the tick rate.
 * - *Not in the pending badge.* The badge means "work not yet on the server". A round being
 *   walked always has some, so counting it would show a number that reads as broken sync for the
 *   entire shift.
 */

export interface ProgressSyncResult {
  /** Sheets the server accepted a report for. */
  pushed: number
  /** Sheets the server refused — none of which costs the operator anything. */
  refused: number
}

/**
 * Whether this operator may report progress for this row.
 *
 * Mirrors `isLogSheetOutboundOwnedByUser`, with `status` inverted: that queue wants delivered
 * work, this one wants work still open. Everything else is the same, and for the same reason —
 * **a tablet is shared and its rows outlive a sign-out.** Pushing a colleague's draft under the
 * signed-in operator's token earns the same 403 that once cost a round's photographs, and it
 * would publish one person's readings under another person's name.
 *
 * Unprovable ownership is a refusal: no owner means no push.
 */
export function isLogSheetProgressOwnedByUser(
  sheet: Pick<
    LogSheet,
    'status' | 'syncStatus' | 'serverStatus' | 'syncError' | 'serverId' | 'assigneeUserId' | 'localOwnerUserId'
  >,
  userId: string | null
): boolean {
  if (!userId) return false
  // A submitted row is the submit queue's business, right through to its outcome.
  if (sheet.status !== 'draft') return false
  if (!sheet.serverId) return false

  const owner = resolveLocalWorkOwner(sheet)
  if (!owner || owner !== userId) return false
  if (sheet.assigneeUserId && sheet.assigneeUserId !== userId) return false

  // Rows the server would refuse on every pass forever. `isRevokedAssignment` covers a sheet
  // that left this operator's inbox; the two status checks cover the ones the server has already
  // closed. Pushing any of them is a request that can only ever fail.
  if (isInvalidLocalLogSheet(sheet)) return false
  if (isRevokedAssignment(sheet)) return false
  if (isLogSheetCancelled(sheet)) return false
  // Unlike a completion — which the server judges on the device's `completedAt`, so on-time work
  // delivered late is still accepted — a progress report is about a round still being walked.
  // There is no earlier moment it could belong to, so a passed deadline ends the reporting.
  if (isLogSheetExpired(sheet)) return false

  return true
}

/**
 * The entries this device has an opinion about and the server has not been told of.
 *
 * `locallyEditedAt` is the only marker that means "somebody edited this **on this device**" —
 * no question about `formData` can answer it, because after any sync the device is holding the
 * server's own values (see `mapServerEntryToLocal`). Since an accepted push clears the marker,
 * "has a marker" is exactly "changed since the last accepted push".
 *
 * A cleared answer is dirty too: emptying a field stamps the marker, so a deliberate clear is
 * reported like any other edit and the server's `wouldBlankUnseenAnswer` decides whether to
 * honour it.
 */
export function dirtyEntriesForProgress(sheet: Pick<LogSheet, 'entries'>): LogSheetEntryData[] {
  return (sheet.entries ?? []).filter(e => e.locallyEditedAt != null)
}

/** Sheets with something to report, for this operator, right now. */
export async function getLogSheetsPendingProgress(userId?: string | null): Promise<LogSheet[]> {
  const resolved = userId === undefined ? await getSessionUserId() : userId
  if (!resolved) return []
  const all = await getAllLogSheets()
  return all.filter(
    sheet =>
      isLogSheetProgressOwnedByUser(sheet, resolved) &&
      dirtyEntriesForProgress(sheet).length > 0
  )
}

function toProgressItem(sheet: LogSheet, entries: LogSheetEntryData[]): LogSheetProgressItem {
  return {
    serverId: Number(sheet.serverId),
    localId: sheet.localId,
    operatorName: sheet.operatorName,
    entries: entries.map(e => ({
      assetId: Number(e.assetId),
      assetName: e.assetName,
      subFunctionCode: e.subFunctionCode,
      subFunctionTag: e.subFunctionTag,
      nfcTagId: e.nfcTagId,
      nfcSerial: e.nfcSerial,
      classId: Number(e.classId),
      formData: e.formData,
      ...(e.createdAt != null ? { createdAt: e.createdAt } : {}),
      ...(e.updatedAt != null ? { updatedAt: e.updatedAt } : {}),
      ...(e.filledVia != null ? { manualEntry: e.filledVia === 'manual' } : {})
    }))
  }
}

/**
 * Forgets this device's opinion about the entries the server has just accepted — and only those.
 *
 * **The conditional part is load-bearing, and getting it wrong fails in both directions.**
 * Clearing every marker would lose an edit the operator made between building the payload and
 * the response arriving: the row would then take the server's older value on the next merge.
 * Clearing none would make the device win those entries on every future merge, so a supervisor's
 * correction in the browser could never reach the tablet — log sheet 85's failure by a third
 * route.
 *
 * So the marker is compared against the snapshot taken when the payload was built. Unchanged
 * means the push covered it; changed means the operator has touched it since and it stays dirty
 * for the next pass.
 */
function clearMarkersForAcceptedEntries(
  entries: LogSheetEntryData[],
  pushedMarkers: Map<string, number | undefined>
): LogSheetEntryData[] {
  return entries.map(entry => {
    const assetId = toIdString(entry.assetId)
    if (!pushedMarkers.has(assetId)) return entry
    if (entry.locallyEditedAt !== pushedMarkers.get(assetId)) return entry
    if (entry.locallyEditedAt == null) return entry
    return { ...entry, locallyEditedAt: undefined }
  })
}

/**
 * Applies one sheet's outcome.
 *
 * Note what is **not** written on any branch: `status`, `syncStatus` and `syncError`. A refused
 * progress push is not a refused submission — the operator's work is untouched and still
 * deliverable — and the ordinary inbox merge is what learns that the round was reassigned or
 * cancelled, from the inbox itself.
 */
async function applyProgressOutcome(
  sheet: LogSheet,
  result: LogSheetProgressResult,
  pushedMarkers: Map<string, number | undefined>
): Promise<'pushed' | 'refused'> {
  const accepted = result.outcome === 'SAVED' || result.outcome === 'NO_CHANGE'

  if (!accepted) {
    await updateLogSheet(sheet.localId, {
      progressSyncStatus: 'failed',
      progressError: result.error ?? undefined
    })
    return 'refused'
  }

  // Re-read rather than reusing the row we sent: an operator can save another asset while the
  // request is in flight, and that save must survive.
  const current = await getLogSheet(sheet.localId)
  const entries = clearMarkersForAcceptedEntries(current?.entries ?? sheet.entries, pushedMarkers)

  await updateLogSheet(sheet.localId, {
    entries,
    progressSyncStatus: 'synced',
    progressSyncedAt: result.savedAt ?? Date.now(),
    progressError: undefined
  })
  return 'pushed'
}

/**
 * One pass of the progress queue.
 *
 * Isolated from the submit batch by its caller: a progress report that will not go through must
 * never fail the delivery of finished work, and vice versa.
 */
export async function pushPendingLogSheetProgress(
  signal?: AbortSignal
): Promise<ProgressSyncResult> {
  const userId = await getSessionUserId()
  const sheets = await getLogSheetsPendingProgress(userId)
  if (sheets.length === 0) return { pushed: 0, refused: 0 }

  const items: LogSheetProgressItem[] = []
  const bySheet = new Map<string, { sheet: LogSheet; markers: Map<string, number | undefined> }>()

  for (const sheet of sheets) {
    const dirty = dirtyEntriesForProgress(sheet)
    if (dirty.length === 0) continue
    const markers = new Map<string, number | undefined>(
      dirty.map(e => [toIdString(e.assetId), e.locallyEditedAt])
    )
    bySheet.set(sheet.localId, { sheet, markers })
    items.push(toProgressItem(sheet, dirty))
  }
  if (items.length === 0) return { pushed: 0, refused: 0 }

  const results = await pushLogSheetProgressBatch(items, signal)

  let pushed = 0
  let refused = 0
  for (const result of results) {
    const tracked = bySheet.get(result.localId)
    if (!tracked) continue
    const outcome = await applyProgressOutcome(tracked.sheet, result, tracked.markers)
    if (outcome === 'pushed') pushed++
    else refused++
  }
  return { pushed, refused }
}
