/**
 * Per-user session isolation on shared tablets.
 * Ensures inbox cache and open drafts from a previous login are not shown to the next user.
 */

import { v4 as uuidv4 } from 'uuid'
import { db } from '@/services/storage/db'
import { getAllLogSheets, getLogSheet, updateLogSheet } from '@/services/storage'
import { getParkedAttachments, retryFailedAttachment } from '@/services/storage/attachments'
import {
  isAttachmentUploadableByUser,
  shouldReviveParkedAttachment
} from '@/utils/attachmentOwnership'
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
import {
  archiveHoldsWorkTheLiveRowLacks,
  resolveLocalWorkOwner,
  sheetHasLocalEntryData
} from '@/utils/logSheetLocalData'
import { toIdString } from '@/utils/ids'
import { fetchBootstrap } from '@/services/api'
import { useAppStore } from '@/store'
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

/**
 * Guarantees the session has a resolved user id, re-binding it if login could not.
 *
 * <p>Almost everything user-scoped keys off this id: outbound sync refuses to push a sheet it
 * cannot attribute (`isLogSheetOutboundOwnedByUser` returns false for a null id) and inbox
 * merge refuses to protect local form data it cannot attribute
 * (`shouldPreserveLocalFormData` likewise). Login binds it from `GET /api/bootstrap`, but that
 * call can fail on its own — a server restart in the window right after the token was issued,
 * a blip, or the session being superseded from another device — and before this existed the
 * app simply carried on with a null id: sync silently pushed nothing, and the first inbox
 * merge could overwrite the operator's typed values.
 *
 * <p>Idempotent and cheap: once bound it is a single IndexedDB read, so callers may invoke it
 * on every sync tick and every inbox refresh, which is exactly how the binding eventually
 * heals without the operator having to log out and back in.
 *
 * @returns the resolved id, or null when the server is still unreachable.
 */
export async function ensureSessionUserId(): Promise<string | null> {
  const existing = await getSessionUserId();
  if (existing) {
    useAppStore.getState().setSessionUserId(existing);
    useAppStore.getState().setSessionBindingPending(false);
    return existing;
  }

  try {
    const bootstrap = await fetchBootstrap();
    const userId = toIdString(bootstrap.userId);
    if (!userId) {
      useAppStore.getState().setSessionBindingPending(true);
      return null;
    }

    await setSessionUserId(userId);
    useAppStore.getState().setSessionUserId(userId);
    useAppStore.getState().setSessionBindingPending(false);

    // Deferred from login: both steps need an identity, and neither could run without one.
    // isolateSheetsNotOwnedBy is only correct now that we know who this actually is.
    const lastUsername = await getLastSessionUsername();
    const currentUsername = useAppStore.getState().authSession?.username ?? null;
    if (lastUsername && currentUsername && lastUsername === currentUsername) {
      await isolateSheetsNotOwnedBy(userId);
      await reviveOwnedSubmittedQueueOnLogin(userId);
    }
    return userId;
  } catch {
    // Offline or server down — stay unbound and let the next attempt try again.
    useAppStore.getState().setSessionBindingPending(true);
    return null;
  }
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
  await reviveOwnedParkedAttachmentsOnLogin(userId)
}

/**
 * Give this operator back the captured media a colleague's session got refused.
 *
 * The counterpart of the loop above, for the same reason: a block that exists because somebody
 * else was holding the tablet is a device-side accident, not a server decision, and it must not
 * outlive the sign-in that ends it.
 *
 * The queue no longer sends another operator's files, so nothing new is parked this way. This
 * exists for the rows already stranded on tablets in the field — photographs, voice notes and
 * video of work that cannot be repeated, which the queue had stopped offering entirely and only
 * a per-file button in the UI could recover.
 */
async function reviveOwnedParkedAttachmentsOnLogin(userId: string): Promise<void> {
  const parked = await getParkedAttachments()
  if (parked.length === 0) return

  const sheets = new Map<string, LogSheet | undefined>()
  for (const row of parked) {
    if (!shouldReviveParkedAttachment(row.failedStatus)) continue
    if (!sheets.has(row.logSheetLocalId)) {
      sheets.set(row.logSheetLocalId, await getLogSheet(row.logSheetLocalId))
    }
    // Judged by the same rule the queue uses, so reviving can never hand somebody a file the
    // very next pass would refuse again.
    if (!isAttachmentUploadableByUser(sheets.get(row.logSheetLocalId), userId)) continue
    await retryFailedAttachment(row.id)
  }
}

function shouldReviveOwnedSubmission(sheet: LogSheet, userId: string): boolean {
  if (sheet.status !== 'submitted' || sheet.syncStatus === 'synced') return false
  const owner = resolveLocalWorkOwner(sheet)
  if (!owner || owner !== userId) return false
  if (isSupersededSyncError(sheet)) return false

  if (isRevokedSyncError(sheet.syncError)) return true

  // serverStatus is the reliable signal here — syncError may instead hold the backend's own
  // translated message (different wording than SYNC_OUTCOME_MESSAGES.EXPIRED on this client).
  if (
    (sheet.serverStatus === 'EXPIRED' || sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) &&
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
    // Only isolate when we actually know who just signed in. With a null id every owned
    // sheet matches `owner !== userId`, so isolating here would archive the whole device's
    // work and fail its drafts on the strength of a bootstrap hiccup. The inbox cache is
    // still cleared — that is display-only and safe — and isolation runs later from
    // ensureSessionUserId() once the identity is actually known.
    if (userIdStr) {
      await isolateSheetsNotOwnedBy(userIdStr)
    }
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

    // A live copy this user owns hides the archive — but ONLY if it actually holds the work.
    //
    // The rule used to be ownership alone, and ownership comes back. Reassigning a sheet away
    // clears the live row (`reset-draft`) and archives what was on it; reassigning it *back*
    // makes the same user the owner of that now-empty row again, so the archive was skipped as
    // stale and the operator's readings became unreachable — still on disk, and shown nowhere.
    // Reproduced end to end: draft with values → assigned to somebody else → archive visible →
    // assigned back → one empty card and nothing else.
    //
    // `sheetHasLocalEntryData` is what separates the two cases. A false revoke during sync
    // leaves the live row holding its values, so it should win and the archive is noise. A
    // cleared row holds nothing, so the archive is the only copy and must stay visible.
    //
    // Nothing is ever copied back automatically. The archive carries `locallyEditedAt` markers,
    // so restored values beat the server's in the next merge and could bury whatever the other
    // operator entered meanwhile — the log sheet 85 failure again. The copy back is an explicit,
    // per-asset action the operator confirms (`restoreArchivedWork.ts`).
    //
    // Which is why the check is per asset rather than per sheet. After a **partial** restore the
    // live row holds what came back and the archive still holds what did not; asking only
    // `sheetHasLocalEntryData(liveRow)` would hide the card at that moment and strand the
    // remainder — the original bug, reintroduced one restore later. Found by running a two-pass
    // restore in a browser, not by a test.
    if (
      liveRow &&
      resolveLocalWorkOwner(liveRow) === userId &&
      sheetHasLocalEntryData(liveRow) &&
      !archiveHoldsWorkTheLiveRowLacks(archived, liveRow)
    ) {
      if (
        liveRow.status === 'submitted' &&
        liveRow.syncStatus === 'synced'
      ) {
        await removeArchivedLogSheet(serverId, userId)
      }
      continue
    }

    // The delivered-and-reconciled case still drops the archive even though the live row was
    // emptied — there is nothing left to recover, and keeping a snapshot of work the server has
    // accepted would show the operator a permanent duplicate of their own submitted round.
    if (
      liveRow &&
      resolveLocalWorkOwner(liveRow) === userId &&
      liveRow.status === 'submitted' &&
      liveRow.syncStatus === 'synced'
    ) {
      await removeArchivedLogSheet(serverId, userId)
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
