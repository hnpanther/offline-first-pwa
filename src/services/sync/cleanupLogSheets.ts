import { getAllLogSheets, deleteLogSheet, getSettings } from '@/services/storage'
import { deleteSyncedAttachmentsForLogSheet } from '@/services/storage/attachments'
import type { LogSheet } from '@/types'
import { isReopenedAfterSync, SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import { resolveRetentionWindows, type RetentionWindows } from '@/services/sync/deviceRetention'
import { isUndeliveredRound } from '@/services/sync/undelivered'

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

  // A draft past its deadline. Purged only when an administrator has switched that on — or, on a
  // device that has never heard from a server that knows the setting, on the shipped constant —
  // and even then never while its readings exist nowhere else (issues P-01, P-05): a draft whose
  // late readings the server kept may go, one whose readings only this tablet holds may not.
  if (isExpiredDraftSheet(sheet)) {
    if (isUndeliveredRound(sheet, now)) return false
    return windows.expiredDraftMs != null && now - expiredDraftAnchor(sheet) > windows.expiredDraftMs
  }

  // An active draft: never.
  if (sheet.status === 'draft') return false

  if (sheet.syncStatus === 'synced') {
    return now - syncedRetentionAnchor(sheet) > windows.syncedMs
  }

  // Refused by the server, under the same rule as an expired draft: only once the server holds
  // its readings (kept for review), never a refusal whose readings are only here (issue P-05) —
  // `VALIDATION_ERROR` awaiting the operator's correction, an `ERROR`, an `EXPIRED` an older
  // server did not keep, or a refusal the server declined to keep (`kept: false`, V26).
  if (sheet.syncStatus === 'failed') {
    if (isUndeliveredRound(sheet, now)) return false
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
 * | Failed, or a draft past its deadline, **whose readings the server holds** (kept for review) | **never** — unless `device.unsynced_purge_enabled` is on; then after `device.unsynced_retention_hours` (default 168 h) |
 * | Any of the above on a device that never received a policy | the shipped constants: 24 h / 7 d / 24 h |
 * | Active draft · submitted, waiting to sync · reopened inside its new deadline · **undelivered** (`isUndeliveredRound`: the readings are only on this tablet) | never, whatever the settings |
 *
 * Deleting a sheet also drops its **already-uploaded** attachments, which would otherwise
 * outlive every screen that could show them and grow the database without bound. Attachments
 * still waiting to upload are kept on purpose: they carry their own server sheet id, so the
 * queue can finish delivering them long after the local sheet is gone.
 */
export async function cleanupLocalLogSheets(now = Date.now()): Promise<number> {
  const all = await getAllLogSheets()
  const survivors = await purgeLocalLogSheets(all, now)
  return all.length - survivors.length
}

/**
 * The same purge over rows the caller has just read, returning the rows that are still there.
 *
 * The sync pass reads the table once and hands the survivors on to the backlog report (issue
 * P-08) — a read taken *before* the purge would count rows it had just deleted. The rows must be
 * fresh: deciding to delete from a stale copy could remove a round that was re-opened meanwhile.
 */
export async function purgeLocalLogSheets(sheets: LogSheet[], now = Date.now()): Promise<LogSheet[]> {
  let windows: RetentionWindows
  try {
    windows = resolveRetentionWindows((await getSettings()).deviceRetention)
  } catch {
    // The settings row could not be read. Purging nothing is always safe — the pass runs again
    // after the next sync — while guessing a window could delete what an administrator chose to
    // keep. A missing or unreadable value must never mean «purge now».
    return sheets
  }

  const survivors: LogSheet[] = []
  for (const sheet of sheets) {
    if (!isEligibleForLocalPurge(sheet, now, windows)) {
      survivors.push(sheet)
      continue
    }
    await deleteLogSheet(sheet.localId)
    await deleteSyncedAttachmentsForLogSheet(sheet.localId)
  }
  return survivors
}
