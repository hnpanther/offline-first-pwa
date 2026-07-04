import { getAllLogSheets, deleteLogSheet } from '@/services/storage'
import type { LogSheet } from '@/types'

const SYNCED_RETENTION_MS = 24 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function syncedRetentionAnchor(sheet: LogSheet): number {
  return sheet.syncedAt ?? sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

function failedRetentionAnchor(sheet: LogSheet): number {
  return sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

/**
 * Purge local log sheets after successful sync when online.
 * - Synced (sent successfully) → keep 1 day in history, then delete
 * - Failed → keep up to 7 days, then delete
 * - Draft (in progress) → never delete
 * - Submitted but still pending sync → keep until synced or failed
 */
export async function cleanupLocalLogSheets(now = Date.now()): Promise<number> {
  const all = await getAllLogSheets()
  let deleted = 0

  for (const sheet of all) {
    if (sheet.status === 'draft') continue

    if (sheet.syncStatus === 'synced') {
      if (now - syncedRetentionAnchor(sheet) > SYNCED_RETENTION_MS) {
        await deleteLogSheet(sheet.localId)
        deleted++
      }
      continue
    }

    if (sheet.syncStatus === 'failed') {
      if (now - failedRetentionAnchor(sheet) > FAILED_RETENTION_MS) {
        await deleteLogSheet(sheet.localId)
        deleted++
      }
    }
  }

  return deleted
}
