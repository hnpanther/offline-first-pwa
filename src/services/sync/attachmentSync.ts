import { uploadAttachment } from '@/services/api'
import { ApiError } from '@/services/api/client'
import {
  getPendingAttachments,
  markAttachmentFailed,
  markAttachmentSynced,
  purgeSyncedAttachmentBlobs
} from '@/services/storage/attachments'
import type { LocalAttachment } from '@/types'

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
 * Parking is what this distinction is *for*: a parked row keeps its reason on screen and stays
 * deletable, but `getPendingAttachments` no longer returns it, so the queue does not re-send a
 * refused file on every pass for the rest of the tablet's life.
 */
function isPermanentFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408
}

export async function syncPendingAttachments(signal?: AbortSignal): Promise<AttachmentSyncResult> {
  const pending = await getPendingAttachments()
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

  const stillPending = await getPendingAttachments()
  return { uploaded, failed, remaining: stillPending.length }
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
    // the reason is recorded so the operator is not left guessing.
    await markAttachmentFailed(attachment.id, message, isPermanentFailure(err))
    return 'failed'
  }
}
