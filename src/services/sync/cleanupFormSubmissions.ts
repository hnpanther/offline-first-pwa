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
 * Same `deviceRetention` windows as rounds (`cleanupLogSheets.ts`):
 * - delivered (`synced`) age out on the synced window
 * - open drafts and pending/syncing finals are never purged
 * - failed finals age out on the unsynced window when that purge is on (or on the legacy
 *   failed window when the device never received a policy)
 *
 * Forms have no `kept` receipt like a refused round. With the unsynced switch **off**
 * (the server default) a failed form is kept forever on the tablet; with it **on**, an
 * aged failure is purged like a kept refusal — the administrator has opted in.
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

  // Refused final — same window as a failed round when the unsynced purge is enabled
  // (or the legacy 7-day window on a device that never received deviceRetention).
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
