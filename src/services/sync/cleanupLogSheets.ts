import { getAllLogSheets, deleteLogSheet } from '@/services/storage'
import type { LogSheet } from '@/types'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'

const SYNCED_RETENTION_MS = 24 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const EXPIRED_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000

function syncedRetentionAnchor(sheet: LogSheet): number {
  return sheet.syncedAt ?? sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

function failedRetentionAnchor(sheet: LogSheet): number {
  return sheet.submittedAt ?? sheet.updatedAt ?? sheet.createdAt
}

function isExpiredDraftSheet(sheet: LogSheet): boolean {
  return (
    sheet.status === 'draft' &&
    (sheet.serverStatus === 'EXPIRED' || sheet.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED)
  )
}

/**
 * Purge local log sheets after successful sync when online.
 * - Synced (sent successfully) → keep 1 day in history, then delete
 * - Failed → keep up to 7 days, then delete
 * - Expired draft → keep 1 day in history, then delete
 * - Active draft (in progress) → never delete
 * - Submitted but still pending sync → keep until synced or failed
 */
export async function cleanupLocalLogSheets(now = Date.now()): Promise<number> {
  const all = await getAllLogSheets()
  let deleted = 0

  for (const sheet of all) {
    if (isExpiredDraftSheet(sheet)) {
      const anchor = sheet.dueAt ?? sheet.updatedAt ?? sheet.createdAt
      if (now - anchor > EXPIRED_DRAFT_RETENTION_MS) {
        await deleteLogSheet(sheet.localId)
        deleted++
      }
      continue
    }

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
