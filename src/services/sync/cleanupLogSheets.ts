import { getAllLogSheets, deleteLogSheet, getSettings } from '@/services/storage'
import { deleteSyncedAttachmentsForLogSheet } from '@/services/storage/attachments'
import type { LogSheet } from '@/types'
import { isReopenedAfterSync, SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import { resolveRetentionWindows, type RetentionWindows } from '@/services/sync/deviceRetention'

function syncedRetentionAnchor(sheet: LogSheet): number {
  return sheet.syncedAt ?? sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

function failedRetentionAnchor(sheet: LogSheet): number {
  return sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

function expiredDraftAnchor(sheet: LogSheet): number {
  return sheet.dueAt ?? sheet.updatedAt ?? sheet.createdAt
}

function isExpiredDraftSheet(sheet: LogSheet): boolean {
  return (
    sheet.status === 'draft' &&
    (sheet.serverStatus === 'EXPIRED' || sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED)
  )
}

/**
 * Whether one local round may be deleted now, under the given windows.
 *
 * Pure, and the whole decision: `cleanupLocalLogSheets` only reads the rows and the windows and
 * deletes what this says. The order of the checks is the order the rules have always been applied
 * in; the reopened, active-draft and pending-sync cases hold **whatever the server's settings
 * say** — no window is even consulted for them.
 */
export function isEligibleForLocalPurge(
  sheet: LogSheet,
  now: number,
  windows: RetentionWindows
): boolean {
  // A completion the supervisor reopened is live work again, not history: the operator has
  // until the new deadline to continue it. Two reasons this must survive the synced purge rather
  // than being re-downloaded fresh from the inbox. First, the row is where the continue action
  // lives, and purging it silently would make the reopened sheet look like untouched new work.
  // Second, `filledVia` is local-only — the server never returns it — so a re-downloaded copy
  // loses which assets were filled manually, and editing one of those after the reopen would
  // re-stamp its `entry_source` as PWA_NFC despite no scan (the same local-only-field trap
  // `mapServerEntryToLocal` carries — see AGENTS.md § Log sheet merge).
  if (isReopenedAfterSync(sheet, now)) return false

  // A draft past its deadline that never reached the server. Its readings exist nowhere else
  // (issue P-01), so it is purged only when an administrator has switched that on — or, on a
  // device that has never heard from a server that knows the setting, on the shipped constant.
  if (isExpiredDraftSheet(sheet)) {
    return windows.expiredDraftMs != null && now - expiredDraftAnchor(sheet) > windows.expiredDraftMs
  }

  // An active draft: never.
  if (sheet.status === 'draft') return false

  if (sheet.syncStatus === 'synced') {
    return now - syncedRetentionAnchor(sheet) > windows.syncedMs
  }

  // Refused by the server — undelivered, under the same rule as an expired draft.
  if (sheet.syncStatus === 'failed') {
    return windows.failedMs != null && now - failedRetentionAnchor(sheet) > windows.failedMs
  }

  // Submitted and still waiting to sync (`pending` / `syncing`): never.
  return false
}

/**
 * Purge local log sheets the device no longer needs. Runs after every sync pass and when the
 * app comes online with a session.
 *
 * How long each kind stays is the **server's** decision (backend roadmap §41): three settings in
 * the panel's «تنظیمات», delivered on bootstrap, read here through `resolveRetentionWindows`.
 *
 * | Local round | Purged |
 * |---|---|
 * | Synced (accepted by the server) | after `device.synced_retention_hours` (default 24 h) |
 * | Failed, or a draft past its deadline | **never** — unless `device.unsynced_purge_enabled` is on; then after `device.unsynced_retention_hours` (default 168 h) |
 * | Any of the above on a device that never received a policy | the shipped constants: 24 h / 7 d / 24 h |
 * | Active draft · submitted, waiting to sync · reopened inside its new deadline | never, whatever the settings |
 *
 * Deleting a sheet also drops its **already-uploaded** attachments, which would otherwise
 * outlive every screen that could show them and grow the database without bound. Attachments
 * still waiting to upload are kept on purpose: they carry their own server sheet id, so the
 * queue can finish delivering them long after the local sheet is gone.
 */
export async function cleanupLocalLogSheets(now = Date.now()): Promise<number> {
  let windows: RetentionWindows
  try {
    windows = resolveRetentionWindows((await getSettings()).deviceRetention)
  } catch {
    // The settings row could not be read. Purging nothing is always safe — the pass runs again
    // after the next sync — while guessing a window could delete what an administrator chose to
    // keep. A missing or unreadable value must never mean «purge now».
    return 0
  }

  const all = await getAllLogSheets()
  let deleted = 0

  for (const sheet of all) {
    if (!isEligibleForLocalPurge(sheet, now, windows)) continue
    await deleteLogSheet(sheet.localId)
    await deleteSyncedAttachmentsForLogSheet(sheet.localId)
    deleted++
  }

  return deleted
}
