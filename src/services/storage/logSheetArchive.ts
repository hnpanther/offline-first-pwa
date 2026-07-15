import { db } from '@/services/storage/db'
import type { LogSheet, LogSheetUserArchive } from '@/types'
import { toIdString } from '@/utils/ids'
import { resolveLocalWorkOwner, sheetHasLocalEntryData } from '@/utils/logSheetLocalData'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'

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
