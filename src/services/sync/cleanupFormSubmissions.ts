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

/**
 * Whether one local form submission may be deleted under the given windows.
 *
 * Delivered forms follow the synced retention window. Drafts and every unconfirmed
 * final (including failed deliveries) are never purged: there is no server-kept receipt
 * for forms, so those readings may exist only here.
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

  // A refusal is not proof of server preservation. Forms have no kept receipt,
  // so even an opt-in unsynced policy must not delete their only recoverable copy.

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
