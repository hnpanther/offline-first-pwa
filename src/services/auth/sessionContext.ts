/**
 * Per-user session isolation on shared tablets.
 * Ensures inbox cache and open drafts from a previous login are not shown to the next user.
 */

import { v4 as uuidv4 } from 'uuid'
import { db } from '@/services/storage/db'
import { getAllLogSheets, updateLogSheet } from '@/services/storage'
import {
  archiveLogSheetForUser,
  archivedLogSheetViewId,
  getArchivedLogSheetsForUser,
  removeArchivedLogSheet
} from '@/services/storage/logSheetArchive'
import { clearInboxSnapshot } from '@/services/storage/inboxCache'
import {
  SYNC_OUTCOME_MESSAGES,
  completedWithinDeadline,
  isRevokedSyncError,
  isSupersededSyncError
} from '@/utils/logSheetStatus'
import { resolveLocalWorkOwner } from '@/utils/logSheetLocalData'
import { toIdString } from '@/utils/ids'
import type { LogSheet } from '@/types'

const SESSION_USER_ID_KEY = 'sessionUserId'
const LAST_USERNAME_KEY = 'lastSessionUsername'

export async function getSessionUserId(): Promise<string | null> {
  const row = await db.syncMeta.get(SESSION_USER_ID_KEY)
  if (row?.value == null) return null
  return toIdString(row.value as string | number)
}

export async function setSessionUserId(userId: number | string): Promise<void> {
  await db.syncMeta.put({ key: SESSION_USER_ID_KEY, value: Number(userId) })
}

export async function getLastSessionUsername(): Promise<string | null> {
  const row = await db.syncMeta.get(LAST_USERNAME_KEY)
  return typeof row?.value === 'string' ? row.value : null
}

async function isolateSheetsNotOwnedBy(userId: string | null): Promise<void> {
  const all = await getAllLogSheets()
  for (const sheet of all) {
    if (!sheet.serverId) continue

    const owner = resolveLocalWorkOwner(sheet)
    if (userId) {
      const isCurrentAssignee = sheet.assigneeUserId === userId
      if (isCurrentAssignee && owner === userId) continue
      if (owner === userId) continue
    } else if (!owner) {
      continue
    }

    if (owner && owner !== userId) {
      await archiveLogSheetForUser(sheet, owner, {
        markRevoked: sheet.status === 'submitted'
      })
    }

    if (sheet.status === 'draft') {
      await updateLogSheet(sheet.localId, {
        syncStatus: 'failed',
        syncError: SYNC_OUTCOME_MESSAGES.REVOKED
      })
      continue
    }

    if (sheet.status === 'submitted' && sheet.syncStatus !== 'synced') {
      await updateLogSheet(sheet.localId, {
        syncStatus: 'failed',
        syncError: SYNC_OUTCOME_MESSAGES.REVOKED
      })
    }
  }
}

/**
 * Restore this user's outbound queue after another user used the shared tablet.
 * Local REVOKED is a device-side block only — not a server decision.
 */
export async function reviveOwnedSubmittedQueueOnLogin(userId: string): Promise<void> {
  const all = await getAllLogSheets()
  for (const sheet of all) {
    if (!shouldReviveOwnedSubmission(sheet, userId)) continue

    await updateLogSheet(sheet.localId, {
      syncError: undefined,
      syncStatus: 'pending',
      clientActionId: uuidv4()
    })
  }
}

function shouldReviveOwnedSubmission(sheet: LogSheet, userId: string): boolean {
  if (sheet.status !== 'submitted' || sheet.syncStatus === 'synced') return false
  const owner = resolveLocalWorkOwner(sheet)
  if (!owner || owner !== userId) return false
  if (isSupersededSyncError(sheet.syncError)) return false

  if (isRevokedSyncError(sheet.syncError)) return true

  if (
    sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED &&
    completedWithinDeadline(sheet)
  ) {
    return true
  }

  return false
}

/** Call after successful login once userId is known (from bootstrap). */
export async function activateUserSession(
  username: string,
  userId: number | string | null
): Promise<void> {
  const prevUsername = await getLastSessionUsername()
  const userIdStr = userId != null ? toIdString(userId) : null

  await db.syncMeta.put({ key: LAST_USERNAME_KEY, value: username })
  if (userIdStr) {
    await setSessionUserId(userIdStr)
  }

  if (prevUsername && prevUsername !== username) {
    await clearInboxSnapshot()
    await isolateSheetsNotOwnedBy(userIdStr)
  }

  if (userIdStr) {
    await reviveOwnedSubmittedQueueOnLogin(userIdStr)
  }
}

export async function clearUserSessionContext(): Promise<void> {
  await db.syncMeta.delete(SESSION_USER_ID_KEY)
  await clearInboxSnapshot()
}

export function isLogSheetAccessibleToUser(
  sheet: Pick<LogSheet, 'assigneeUserId' | 'localOwnerUserId' | 'serverId' | 'status' | 'syncError'>,
  userId: string | null,
  inboxAssignedServerIds: ReadonlySet<string>
): boolean {
  if (!userId) return false

  const owner = resolveLocalWorkOwner(sheet)
  if (owner === userId) return true

  const serverId = sheet.serverId ? toIdString(sheet.serverId) : null
  if (serverId && inboxAssignedServerIds.has(serverId)) {
    if (owner && owner !== userId) return false
    return sheet.assigneeUserId === userId || sheet.assigneeUserId == null
  }

  if (sheet.assigneeUserId) {
    return sheet.assigneeUserId === userId
  }

  return false
}

/** Outbound sync queue: only sheets submitted by the current assignee on this device. */
export function isLogSheetOutboundOwnedByUser(
  sheet: Pick<LogSheet, 'assigneeUserId' | 'localOwnerUserId' | 'status' | 'syncStatus'>,
  userId: string | null
): boolean {
  if (!userId) return false
  if (sheet.status !== 'submitted') return false
  if (sheet.syncStatus === 'synced' || sheet.syncStatus === 'failed') return false
  const owner = resolveLocalWorkOwner(sheet)
  if (!owner || owner !== userId) return false
  if (sheet.assigneeUserId && sheet.assigneeUserId !== userId) return false
  return true
}

export function filterLogSheetsForUser(
  sheets: LogSheet[],
  userId: string | null,
  inboxAssignedServerIds: ReadonlySet<string>
): LogSheet[] {
  if (!userId) return []
  return sheets.filter(s =>
    isLogSheetAccessibleToUser(s, userId, inboxAssignedServerIds)
  )
}

/** Live sheets plus archived copies for this user on a shared tablet. */
export async function loadLogSheetsForSessionUser(
  sheets: LogSheet[],
  userId: string | null,
  inboxAssignedServerIds: ReadonlySet<string>
): Promise<LogSheet[]> {
  if (!userId) return []

  const live = filterLogSheetsForUser(sheets, userId, inboxAssignedServerIds)
  const archives = await getArchivedLogSheetsForUser(userId)
  const liveByServer = new Map(
    live.filter(s => s.serverId).map(s => [toIdString(s.serverId!), s])
  )

  const merged = [...live]
  for (const archived of archives) {
    if (!archived.serverId) continue
    const serverId = toIdString(archived.serverId)
    const liveRow = liveByServer.get(serverId)

    // Live owned copy always wins — drop stale archive rows (e.g. false revoke during sync).
    if (liveRow && resolveLocalWorkOwner(liveRow) === userId) {
      if (
        liveRow.status === 'submitted' &&
        liveRow.syncStatus === 'synced'
      ) {
        await removeArchivedLogSheet(serverId, userId)
      }
      continue
    }

    const completedOwnWork =
      archived.status === 'submitted' &&
      (archived.syncStatus === 'synced' || archived.serverStatus === 'SUBMITTED')

    merged.push({
      ...archived,
      localId: archivedLogSheetViewId(serverId, userId),
      ...(completedOwnWork
        ? {
            status: 'submitted' as const,
            syncStatus: 'synced' as const,
            syncError: undefined,
            serverStatus: archived.serverStatus ?? 'SUBMITTED'
          }
        : {
            syncStatus: 'failed' as const,
            syncError: SYNC_OUTCOME_MESSAGES.REASSIGNED
          })
    })
  }

  return merged.sort((a, b) => b.updatedAt - a.updatedAt)
}
