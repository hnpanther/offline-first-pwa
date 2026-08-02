import { db } from '@/services/storage/db'
import type { LogSheet, LogSheetUserArchive } from '@/types'
import { toIdString } from '@/utils/ids'
import { resolveLocalWorkOwner, sheetHasLocalEntryData } from '@/utils/logSheetLocalData'
import {
  SYNC_OUTCOME_MESSAGES,
  isLogSheetExpiredForSync,
  isSupersededSyncError
} from '@/utils/logSheetStatus'

function archiveId(serverId: string, userId: string): string {
  return `${serverId}:${userId}`
}

/** Route-safe localId for viewing an archived snapshot (not stored in logSheets). */
export function archivedLogSheetViewId(serverId: string, userId: string): string {
  return `archive:${serverId}:${userId}`
}

export function parseArchivedLogSheetViewId(
  localId: string
): { serverId: string; userId: string } | null {
  const match = /^archive:(.+):(.+)$/.exec(localId)
  if (!match) return null
  return { serverId: match[1], userId: match[2] }
}

export async function getArchivedLogSheetByViewId(
  viewId: string
): Promise<LogSheet | null> {
  const parsed = parseArchivedLogSheetViewId(viewId)
  if (!parsed) return null
  const row = await db.logSheetUserArchives.get(
    archiveId(parsed.serverId, parsed.userId)
  )
  return row?.sheet ?? null
}

export async function archiveLogSheetForUser(
  sheet: LogSheet,
  userId: string,
  options?: { markRevoked?: boolean }
): Promise<void> {
  if (!sheet.serverId) return
  const hasWork = sheet.status === 'submitted' || sheetHasLocalEntryData(sheet)
  if (!hasWork) return
  const serverId = toIdString(sheet.serverId)
  const snapshot: LogSheet = {
    ...sheet,
    localOwnerUserId: userId,
    ...(options?.markRevoked
      ? { syncStatus: 'failed' as const, syncError: SYNC_OUTCOME_MESSAGES.REASSIGNED }
      : {})
  }
  const row: LogSheetUserArchive = {
    id: archiveId(serverId, userId),
    serverId,
    userId,
    sheet: snapshot,
    archivedAt: Date.now()
  }
  await db.logSheetUserArchives.put(row)
}

/** Archive before clearing another user's local work (shared-tablet safety net). */
export async function archiveLocalWorkBeforeClear(sheet: LogSheet): Promise<void> {
  const owner = resolveLocalWorkOwner(sheet)
  if (!owner) return
  const markRevoked = sheet.status === 'submitted'
  await archiveLogSheetForUser(sheet, owner, { markRevoked })
}

export async function getArchivedLogSheetsForUser(
  userId: string
): Promise<LogSheet[]> {
  const rows = await db.logSheetUserArchives.where('userId').equals(userId).toArray()
  return rows
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .map(r => r.sheet)
}

export async function removeArchivedLogSheet(
  serverId: string,
  userId: string
): Promise<void> {
  await db.logSheetUserArchives.delete(archiveId(toIdString(serverId), userId))
}

/**
 * Whether an archived snapshot still holds a completion the server has never seen,
 * so it must still be pushed (normally to be recorded as a void submission).
 *
 * Archiving happens when another user takes the device/sheet over, which detaches the
 * original operator's completed-but-unsynced work from the live `logSheets` row — the
 * only thing the outbound queue used to look at. Without this, that work silently dies
 * on the device: the server never learns it happened, so it never records a void.
 *
 * `syncedAt` is the resolution marker: it is set as soon as the server responds with any
 * definitive outcome, so a rejected push is not retried forever.
 */
export function isArchivedSubmissionPendingServerOutcome(
  sheet: Pick<
    LogSheet,
    'serverId' | 'status' | 'syncStatus' | 'serverStatus' | 'syncError' | 'syncedAt'
    | 'dueAt' | 'completedAt' | 'submittedAt'
  >,
  now = Date.now()
): boolean {
  if (!sheet.serverId) return false
  if (sheet.status !== 'submitted') return false
  if (sheet.syncStatus === 'synced') return false
  if (sheet.syncedAt != null) return false
  if (isSupersededSyncError(sheet)) return false
  if (isLogSheetExpiredForSync(sheet, now)) return false
  return true
}

/**
 * This user's archived completions still awaiting a server outcome, shaped for the
 * outbound batch. `localId` is remapped to the archive view id so sync results can be
 * routed back to the archive row instead of the live `logSheets` row — after a takeover
 * both share the same original `localId`, and the live one now belongs to someone else.
 */
export async function getArchivedSubmissionsPendingServerOutcome(
  userId: string,
  now = Date.now()
): Promise<LogSheet[]> {
  const rows = await db.logSheetUserArchives.where('userId').equals(userId).toArray()
  return rows
    .filter(r => isArchivedSubmissionPendingServerOutcome(r.sheet, now))
    .map(r => ({ ...r.sheet, localId: archivedLogSheetViewId(toIdString(r.serverId), userId) }))
}

export async function updateArchivedLogSheetSnapshot(
  serverId: string,
  userId: string,
  updates: Partial<LogSheet>
): Promise<void> {
  const id = archiveId(toIdString(serverId), userId)
  const row = await db.logSheetUserArchives.get(id)
  if (!row) return
  await db.logSheetUserArchives.put({ ...row, sheet: { ...row.sheet, ...updates } })
}
