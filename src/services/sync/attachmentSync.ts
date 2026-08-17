import { deleteRemoteAttachment, uploadAttachment } from '@/services/api'
import { ApiError } from '@/services/api/client'
import {
  deleteAttachment,
  getPendingAttachmentDeletes,
  getPendingAttachments,
  markAttachmentFailed,
  markAttachmentSynced,
  purgeSyncedAttachmentBlobs
} from '@/services/storage/attachments'
import { getLogSheet, getLogSheetByServerId } from '@/services/storage'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { isAttachmentUploadableByUser } from '@/utils/attachmentOwnership'
import { toIdString } from '@/utils/ids'
import type { LocalAttachment, LogSheet } from '@/types'

/**
 * Uploading captured media, one file at a time, outside the log-sheet batch.
 *
 * Keeping this separate is the whole design. A submission carries the readings and must stay
 * small and atomic; a 400 KB photo inside it would mean every dropped connection retried the
 * entire shift's work. Here a dropped connection costs exactly one file, and the next pass
 * picks up where this one stopped.
 *
 * **Sequential on purpose.** Field tablets are on weak links; three concurrent uploads there
 * are slower than one and far more likely to time out. Sequential also keeps the progress
 * count honest and bounds memory to a single blob at a time.
 */

export interface AttachmentSyncResult {
  uploaded: number
  failed: number
  /** Deletions carried to the server (or resolved as already gone) on this pass. */
  deleted: number
  /** Rows still waiting — including ones this pass never reached. */
  remaining: number
}

/**
 * A failure that will never succeed on retry, so the row is parked rather than looped on.
 *
 * 4xx here means the server examined the request and refused it: the field is not an
 * attachment field, the type is not accepted, the sheet is gone. Re-sending identical bytes
 * gets an identical refusal. 401 is excluded because that is a session problem, not a payload
 * problem — the unauthorized handler deals with it and the file stays retryable. 408 likewise
 * describes the connection, not the file.
 *
 * **409 is excluded too, and that one was learned the hard way.** The server answers 409 for a
 * refusal about *state* rather than payload — today that is "this field already holds its
 * maximum number of attachments". Parking those was half of a real field bug: an operator
 * deleted a photo (which used to free a slot only on the device, never on the server), took
 * another, and the upload was refused and buried for good. The bytes were fine; the field was
 * momentarily full. Anything that can become true again later has to stay in the queue.
 *
 * Parking is what this distinction is *for*: a parked row keeps its reason on screen and stays
 * deletable, but `getPendingAttachments` no longer returns it, so the queue does not re-send a
 * refused file on every pass for the rest of the tablet's life.
 */
function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  if (err.status === 401 || err.status === 408 || err.status === 409) return false
  // 403 joins them, and for the same reason. On a shared tablet it means "the operator signed in
  // right now may not touch this sheet" — a fact about who is holding the device, not about the
  // file, and one that stops being true when the owner signs back in. Parking those is how a
  // whole round's photographs were lost when a colleague picked the tablet up: the queue never
  // offered them again. The owner filter below should make this unreachable; it stays because
  // being wrong in this direction costs retries, and being wrong the other way costs evidence.
  if (err.status === 403) return false
  return err.status >= 400 && err.status < 500
}

/**
 * The attachments of **this** operator's work.
 *
 * A tablet is shared and its rows outlive a sign-out, so "everything queued on this device" and
 * "everything this operator may send" are different sets — see `isAttachmentUploadableByUser`
 * for what happened when they were treated as one. Sheets are read once each rather than per
 * attachment: a round with a photo on every asset is dozens of rows against a handful of sheets.
 */
async function ownWork(
  rows: LocalAttachment[],
  userId: string | null
): Promise<LocalAttachment[]> {
  if (rows.length === 0) return []
  const sheets = new Map<string, LogSheet | undefined>()
  const out: LocalAttachment[] = []
  for (const row of rows) {
    if (!sheets.has(row.logSheetLocalId)) {
      sheets.set(row.logSheetLocalId, await getLogSheet(row.logSheetLocalId))
    }
    if (isAttachmentUploadableByUser(sheets.get(row.logSheetLocalId), userId)) out.push(row)
  }
  return out
}

/** Files this operator still has to deliver — the number the pending badge is built from. */
export async function getOwnPendingAttachments(): Promise<LocalAttachment[]> {
  return ownWork(await getPendingAttachments(), await getSessionUserId())
}

export async function syncPendingAttachments(signal?: AbortSignal): Promise<AttachmentSyncResult> {
  const userId = await getSessionUserId()

  // Deletions first, and deliberately so: each one frees a slot against the server's per-field
  // ceiling, so a capture that replaced a deleted file is accepted on this same pass instead of
  // being refused and having to wait for the next one.
  const deleted = await drainPendingDeletes(userId, signal)

  const pending = await ownWork(await getPendingAttachments(), userId)
  let uploaded = 0
  let failed = 0

  for (const attachment of pending) {
    if (signal?.aborted) break
    const outcome = await uploadOne(attachment, signal)
    if (outcome === 'uploaded') uploaded++
    else if (outcome === 'failed') failed++
    else break // transport died — stop the pass rather than hammering a dead link
  }

  // Reclaim space from files that have been safely on the server long enough.
  await purgeSyncedAttachmentBlobs()

  // Counted the same way, so the badge reflects what this pass could actually deliver rather
  // than what happens to be sitting on the device.
  const stillPending = await ownWork(await getPendingAttachments(), userId)
  return { uploaded, failed, deleted, remaining: stillPending.length }
}

/**
 * Carries the operator's deletions to the server.
 *
 * **The rule that decides each one is whether the sheet has been submitted.** Before submission
 * the attachment is part of work still being assembled, so removing it should remove it
 * everywhere — otherwise the server keeps counting a file nobody can see against the field's
 * ceiling, and the operator is refused a replacement for a photo they already deleted. After
 * submission it is delivered evidence: the local copy may go, the server's may not. Tidying a
 * tablet must never erase the record of work that was actually done.
 *
 * A sheet that is gone locally is treated as submitted — the conservative reading. Cleanup only
 * retires sheets that reached a terminal state, so "no local row" almost always means "delivered
 * and purged", and guessing wrong in this direction costs a stale file rather than lost evidence.
 *
 * **Ownership is checked on the branch that talks to the server, and only there.** Telling the
 * server to delete another operator's file is the same trespass as uploading one, and earns the
 * same 403. The other branch touches nothing but this device's own row, so gating it on
 * ownership would strand tidy-up work forever on exactly the rows whose sheet is already gone —
 * which is the case it exists to handle.
 */
async function drainPendingDeletes(
  userId: string | null,
  signal?: AbortSignal
): Promise<number> {
  const rows = await getPendingAttachmentDeletes()
  let removed = 0

  for (const row of rows) {
    if (signal?.aborted) break
    const sheet = row.logSheetServerId
      ? await getLogSheetByServerId(toIdString(row.logSheetServerId))
      : undefined
    const submitted = !sheet || sheet.status === 'submitted'

    if (submitted) {
      // Keep the server's copy; the local row has served its purpose.
      await deleteAttachment(row.id)
      removed++
      continue
    }

    // From here a request goes out under the signed-in operator's token.
    if (!isAttachmentUploadableByUser(sheet, userId)) continue

    try {
      await deleteRemoteAttachment(row.id, signal)
      await deleteAttachment(row.id)
      removed++
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already absent — the desired end state, reached by some other route.
        await deleteAttachment(row.id)
        removed++
        continue
      }
      if (err instanceof ApiError && err.status === 0) {
        // Offline. The row stays marked and the next pass tries again.
        break
      }
      // Anything else (403, 409, a 5xx): leave it queued rather than dropping the row, or the
      // deletion would be forgotten and the slot stay consumed with nothing left to retry.
      break
    }
  }

  return removed
}

type UploadOutcome = 'uploaded' | 'failed' | 'aborted'

async function uploadOne(
  attachment: LocalAttachment,
  signal?: AbortSignal
): Promise<UploadOutcome> {
  if (!attachment.blob || !attachment.logSheetServerId) {
    // Not an error: the sheet has not synced yet, so the server has nowhere to put this.
    return 'failed'
  }
  try {
    await uploadAttachment({
      id: attachment.id,
      logSheetServerId: attachment.logSheetServerId,
      assetId: attachment.assetId,
      fieldKey: attachment.fieldKey,
      blob: attachment.blob,
      width: attachment.width,
      height: attachment.height,
      durationMs: attachment.durationMs,
      signal
    })
    await markAttachmentSynced(attachment.id)
    return 'uploaded'
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      // Offline or server unreachable — leave the row exactly as it was so the next pass
      // retries it. Marking it failed here would make a network blip look like a rejection.
      return 'aborted'
    }
    const message = err instanceof Error ? err.message : 'خطا در ارسال پیوست'
    // Permanent → parked (never retried). 5xx or anything unclassified → still retryable, but
    // the reason is recorded so the operator is not left guessing. The status is recorded too,
    // because the reason text is the server's own translated sentence and cannot be classified
    // later — see `LocalAttachment.failedStatus`.
    await markAttachmentFailed(
      attachment.id,
      message,
      isPermanentFailure(err),
      err instanceof ApiError ? err.status : undefined
    )
    return 'failed'
  }
}
