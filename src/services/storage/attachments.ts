import { db } from '@/services/storage/db'
import { toIdString } from '@/utils/ids'
import type { AttachmentKind, AttachmentRef, LocalAttachment } from '@/types'

/**
 * Local storage for captured media.
 *
 * Blobs are stored **natively** — IndexedDB supports them, and base64 would inflate every file
 * by a third while forcing a decode on every render. The row outlives the blob: once a file is
 * safely on the server the bytes can be dropped to reclaim device space while the metadata
 * stays, so the UI can still describe the attachment and fetch it on demand when online.
 */

/** How long a synced attachment's bytes stay on the device before being reclaimed. */
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export async function saveAttachment(attachment: LocalAttachment): Promise<void> {
  await db.attachments.put(attachment)
}

export async function getAttachment(id: string): Promise<LocalAttachment | undefined> {
  return db.attachments.get(id)
}

export async function getAttachmentsByIds(ids: string[]): Promise<LocalAttachment[]> {
  if (ids.length === 0) return []
  const rows = await db.attachments.bulkGet(ids)
  return rows.filter((r): r is LocalAttachment => r != null)
}

export async function getAttachmentsForEntry(
  logSheetLocalId: string,
  assetId: string,
  fieldKey: string
): Promise<LocalAttachment[]> {
  const rows = await db.attachments.where('logSheetLocalId').equals(logSheetLocalId).toArray()
  return rows
    .filter(r => toIdString(r.assetId) === toIdString(assetId) && r.fieldKey === fieldKey)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteAttachment(id: string): Promise<void> {
  await db.attachments.delete(id)
}

/**
 * Attachments still waiting to reach the server.
 *
 * Three kinds of row are skipped, for three different reasons:
 * - **no `logSheetServerId`** — the server keys an attachment to a log sheet, so uploading
 *   before the sheet exists there is impossible. Picked up once the sheet syncs.
 * - **no `blob`** — the bytes were reclaimed after a successful upload; nothing left to send.
 * - **`permanentFailure`** — the server examined this file and refused it. Identical bytes get
 *   an identical refusal, so retrying is pure waste.
 */
export async function getPendingAttachments(): Promise<LocalAttachment[]> {
  const rows = await db.attachments.where('syncStatus').anyOf('pending', 'failed').toArray()
  return rows.filter(r => r.blob != null && !!r.logSheetServerId && !r.permanentFailure)
}

export async function markAttachmentSynced(id: string, uploadedAt = Date.now()): Promise<void> {
  await db.attachments.update(id, {
    syncStatus: 'synced',
    syncError: undefined,
    permanentFailure: undefined,
    uploadedAt
  })
}

/**
 * @param permanent when true the row is parked and the queue stops retrying it. Reserve this
 *        for refusals the server will repeat — never for anything that smells like transport.
 */
export async function markAttachmentFailed(
  id: string,
  syncError: string,
  permanent = false
): Promise<void> {
  await db.attachments.update(id, {
    syncStatus: 'failed',
    syncError,
    permanentFailure: permanent || undefined
  })
}

/**
 * Clears the parked flag so the queue picks the file up again.
 *
 * The escape hatch for a rejection that was actually about server state rather than the file —
 * a sheet that had not been generated yet, a field added after the tablet last synced.
 */
export async function retryFailedAttachment(id: string): Promise<void> {
  await db.attachments.update(id, {
    syncStatus: 'pending',
    syncError: undefined,
    permanentFailure: undefined
  })
}

/**
 * Drops the bytes of attachments that are safely on the server and older than the retention
 * window, keeping the row.
 *
 * Without this a tablet accumulates every photo ever taken on it. The row survives so the
 * attachment still appears in the form; opening it then fetches from the server.
 */
export async function purgeSyncedAttachmentBlobs(
  olderThanMs = ATTACHMENT_RETENTION_MS,
  now = Date.now()
): Promise<number> {
  const rows = await db.attachments.where('syncStatus').equals('synced').toArray()
  let purged = 0
  for (const row of rows) {
    if (!row.blob) continue
    const uploadedAt = row.uploadedAt ?? row.createdAt
    if (now - uploadedAt < olderThanMs) continue
    await db.attachments.update(row.id, { blob: undefined })
    purged++
  }
  return purged
}

/** Removes every attachment of a sheet — used when local work for that sheet is discarded. */
export async function deleteAttachmentsForLogSheet(logSheetLocalId: string): Promise<void> {
  await db.attachments.where('logSheetLocalId').equals(logSheetLocalId).delete()
}

/**
 * Removes the attachments of a sheet that can no longer do anything useful.
 *
 * Used when a local sheet is retired by the cleanup pass. Two kinds go:
 * - **synced** — already on the server, so the local copy is redundant.
 * - **parked** (`permanentFailure`) — the server refused it and it is no longer queued; once
 *   the sheet is gone there is no screen left to view it on and no button left to retry it
 *   from, so keeping the bytes would be an unbounded leak with no path back.
 *
 * Rows still genuinely waiting are left behind: they hold their own `logSheetServerId`, so the
 * queue can still deliver them, and dropping them would discard the operator's evidence.
 *
 * @returns how many rows were removed
 */
export async function deleteSyncedAttachmentsForLogSheet(
  logSheetLocalId: string
): Promise<number> {
  return db.attachments
    .where('logSheetLocalId')
    .equals(logSheetLocalId)
    .filter(row => row.syncStatus === 'synced' || row.permanentFailure === true)
    .delete()
}

/** Stamps the server id onto a sheet's attachments once the sheet itself has one. */
export async function bindAttachmentsToServerSheet(
  logSheetLocalId: string,
  logSheetServerId: string
): Promise<void> {
  await db.attachments
    .where('logSheetLocalId')
    .equals(logSheetLocalId)
    .modify({ logSheetServerId })
}

/** The canonical value stored in `formData` for an attachment field. */
export function buildAttachmentRef(ids: string[]): AttachmentRef {
  return { type: 'attachment', ids }
}

/**
 * Ids held by a form value.
 *
 * Mirrors the server's own parser: tolerant about shape (an older client may have stored a
 * bare array), strict about content — a blank entry would be a reference that never resolves.
 */
export function attachmentIdsOf(value: unknown): string[] {
  const push = (out: string[], candidate: unknown) => {
    if (candidate == null) return
    const id = String(candidate).trim()
    if (!id || id === 'null' || out.includes(id)) return
    out.push(id)
  }

  const out: string[] = []
  if (value == null) return out
  if (Array.isArray(value)) {
    value.forEach(v => push(out, v))
    return out
  }
  if (typeof value === 'object') {
    const ids = (value as { ids?: unknown }).ids
    if (Array.isArray(ids)) {
      ids.forEach(v => push(out, v))
    } else {
      push(out, ids)
    }
    return out
  }
  push(out, value)
  return out
}

/** The attachment kind a field's data type accepts, or null when it takes no media. */
export function attachmentKindForDataType(dataType: string | undefined): AttachmentKind | null {
  switch ((dataType ?? '').trim().toLowerCase()) {
    case 'image':
      return 'IMAGE'
    case 'audio':
      return 'AUDIO'
    case 'video':
      return 'VIDEO'
    default:
      return null
  }
}
