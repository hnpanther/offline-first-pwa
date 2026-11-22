import { getSettings } from '@/services/storage'
import {
  deleteFormSubmission,
  getAllFormSubmissions
} from '@/services/storage/formSubmissions'
import { deleteSyncedAttachmentsForFormSubmission } from '@/services/storage/attachments'
import { resolveRetentionWindows, type RetentionWindows } from '@/services/sync/deviceRetention'
import {
  isCompletedFormServerStatus,
  type LocalFormSubmission
} from '@/types'

function syncedRetentionAnchor(row: LocalFormSubmission): number {
  return row.syncedAt ?? row.submittedAt ?? row.updatedAt ?? row.createdAt
}

function failedRetentionAnchor(row: LocalFormSubmission): number {
  return row.submittedAt ?? row.updatedAt ?? row.createdAt
}

/**
 * Whether one local form submission may be deleted under the given windows.
 *
 * Parity with `isEligibleForLocalPurge` for rounds, simplified: forms have no
 * deadline / reopen / late-progress path. Undelivered drafts and pending finals
 * are never purged — the readings exist only here.
 */
export function isEligibleForFormLocalPurge(
  row: LocalFormSubmission,
  now: number,
  windows: RetentionWindows
): boolean {
  // Open draft — never, whatever the settings.
  if (row.status === 'draft') return false

  // Final still waiting to sync — never.
  if (row.syncStatus === 'pending' || row.syncStatus === 'syncing') return false

  if (row.syncStatus === 'synced') {
    // APPROVED is delivered the same way SUBMITTED is; VOIDED that already synced
    // follows the synced window too (server holds the record).
    if (
      row.serverStatus != null &&
      !isCompletedFormServerStatus(row.serverStatus) &&
      row.serverStatus !== 'VOIDED'
    ) {
      // Unknown / DRAFT-on-a-synced-row: keep until we understand it.
      return false
    }
    return now - syncedRetentionAnchor(row) > windows.syncedMs
  }

  // Refused final (`failed`). Only when the server's unsynced purge switch is on —
  // and never treat a VALIDATION_ERROR awaiting correction as disposable if we have
  // no proof the server kept a copy. Forms have no `serverKeptAt`, so failed rows
  // are undelivered: purge only under the unsynced window when that switch is on
  // (same family as log-sheet failed-with-kept when the admin opts in).
  if (row.syncStatus === 'failed') {
    return windows.failedMs != null && now - failedRetentionAnchor(row) > windows.failedMs
  }

  return false
}

/** Purge local form submissions the device no longer needs. Same windows as rounds. */
export async function cleanupLocalFormSubmissions(now = Date.now()): Promise<number> {
  const all = await getAllFormSubmissions()
  const survivors = await purgeLocalFormSubmissions(all, now)
  return all.length - survivors.length
}

export async function purgeLocalFormSubmissions(
  rows: LocalFormSubmission[],
  now = Date.now()
): Promise<LocalFormSubmission[]> {
  let windows: RetentionWindows
  try {
    windows = resolveRetentionWindows((await getSettings()).deviceRetention)
  } catch {
    return rows
  }

  const survivors: LocalFormSubmission[] = []
  for (const row of rows) {
    if (!isEligibleForFormLocalPurge(row, now, windows)) {
      survivors.push(row)
      continue
    }
    await deleteFormSubmission(row.localId)
    await deleteSyncedAttachmentsForFormSubmission(row.localId)
  }
  return survivors
}
