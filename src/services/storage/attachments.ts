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
  return rows.filter((r): r is LocalAttachment => r != null && !r.pendingDelete)
}

export async function getAttachmentsForEntry(
  logSheetLocalId: string,
  assetId: string,
  fieldKey: string
): Promise<LocalAttachment[]> {
  const rows = await db.attachments.where('logSheetLocalId').equals(logSheetLocalId).toArray()
  return rows
    .filter(r => !r.pendingDelete)
    .filter(r => toIdString(r.assetId) === toIdString(assetId) && r.fieldKey === fieldKey)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteAttachment(id: string): Promise<void> {
  await db.attachments.delete(id)
}

/**
 * Marks a file the operator removed that the **server still holds**, so the deletion can be
 * carried to the server on the next pass.
 *
 * The row survives instead of being deleted outright because the deletion itself is a piece of
 * pending work: the tablet is routinely offline when the operator changes their mind, and a row
 * that was simply dropped locally leaves the server copy behind forever. That divergence is
 * what caused the original bug — the server counts its own attachments against the per-field
 * ceiling, so every local-only delete permanently consumed a slot the operator could see was
 * free, and the next capture was refused.
 *
 * `pendingDelete` is a plain, non-indexed property (like `permanentFailure`) — no Dexie version
 * bump. Every read path filters it out, so the file is gone from the operator's point of view
 * the moment they tap delete, whether or not there is a network.
 */
export async function markAttachmentPendingDelete(id: string): Promise<void> {
  await db.attachments.update(id, {
    pendingDelete: true,
    // Leaving it queued would race the deletion: the upload pass could re-send the very file
    // the delete pass is about to remove, and on a slow link the two can interleave.
    syncStatus: 'synced'
  })
}

/**
 * Removes an attachment the operator deleted, queueing a server-side deletion when the server
 * holds a copy.
 *
 * **The row is re-read here rather than passed in, and that is the point of the function.** The
 * caller is a React component holding a snapshot from its last render, while the upload queue
 * marks rows `synced` in the background — so by the time somebody taps delete, a row the screen
 * still believes is `pending` is very often already on the server. Deciding from that stale copy
 * sends the file down the local-only path and orphans the server's copy, which is the exact
 * divergence this mechanism exists to prevent. Found in a live run: the unit tests missed it
 * because they called the marker directly and never went through the component's snapshot.
 *
 * **The question is "might the server have this", not "do we know it does".** The condition used
 * to be `syncStatus === 'synced'`, which is the second question, and the two differ exactly when
 * it matters: an upload whose response never arrived — a timeout, a 502, a link that dropped
 * after the server committed — leaves the row `pending` or `failed` here while the file sits on
 * the server. Deleting such a row locally orphans the server's copy, and because the server
 * counts its own rows against the per-field ceiling, a one-clip field is then **full forever**
 * with nothing the operator can delete: the device no longer knows the file exists. That is a
 * dead end an operator cannot escape, and it was reached in the field on a one-video field.
 *
 * Asking the server to delete something it does not have costs one request: `drainPendingDeletes`
 * already treats `404` as the desired end state. Being wrong in that direction costs a no-op;
 * being wrong the other way costs the operator the rest of their round. Same trade as
 * `isPermanentFailure`'s 403 branch, for the same reason.
 *
 * A row with no `logSheetServerId` still goes locally: the upload queue is gated on that field,
 * so the file cannot have reached the server and there is nothing to ask about.
 *
 * @returns `queued` when the server still has to be told, `dropped` when the row was local only
 */
export async function removeAttachment(id: string): Promise<'queued' | 'dropped'> {
  const row = await getAttachment(id)
  if (row?.logSheetServerId) {
    await markAttachmentPendingDelete(id)
    return 'queued'
  }
  await deleteAttachment(id)
  return 'dropped'
}

/**
 * Deletions waiting to reach the server.
 *
 * Only rows the server can actually be asked about: one with no `logSheetServerId` was never
 * uploaded, so there is nothing there to delete and the row can simply go.
 */
export async function getPendingAttachmentDeletes(): Promise<LocalAttachment[]> {
  const rows = await db.attachments.filter(r => r.pendingDelete === true).toArray()
  return rows.filter(r => !!r.logSheetServerId)
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
  return rows.filter(
    r => r.blob != null && !!r.logSheetServerId && !r.permanentFailure && !r.pendingDelete
  )
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
 * @param failedStatus the HTTP status the server answered with. Recorded because "why was this
 *        parked" is otherwise unanswerable later: the stored `syncError` is the backend's own
 *        translated sentence, which no code can classify. It is what lets a row parked because
 *        the wrong operator was signed in be told apart from one holding a file the server will
 *        never accept. Plain, non-indexed property — no Dexie version bump.
 */
export async function markAttachmentFailed(
  id: string,
  syncError: string,
  permanent = false,
  failedStatus?: number
): Promise<void> {
  await db.attachments.update(id, {
    syncStatus: 'failed',
    syncError,
    permanentFailure: permanent || undefined,
    failedStatus
  })
}

/** Rows the queue has stopped returning, so they can be reconsidered. */
export async function getParkedAttachments(): Promise<LocalAttachment[]> {
  const rows = await db.attachments.where('syncStatus').equals('failed').toArray()
  return rows.filter(r => r.permanentFailure === true && !r.pendingDelete)
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
    permanentFailure: undefined,
    failedStatus: undefined
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
