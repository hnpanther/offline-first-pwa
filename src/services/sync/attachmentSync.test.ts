import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import {
  getAttachment,
  retryFailedAttachment,
  saveAttachment
} from '@/services/storage/attachments'
import { syncPendingAttachments } from '@/services/sync/attachmentSync'
import type { LocalAttachment } from '@/types'

const uploadAttachment = vi.fn()
vi.mock('@/services/api', () => ({
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args)
}))

/**
 * The upload queue's job is to decide, for each failure, whether to keep trying.
 *
 * Getting that wrong is expensive in both directions: retrying a request the server has
 * definitively refused burns a field tablet's battery and data forever, while parking a row
 * after a passing network blip silently loses the operator's photo. These tests pin down every
 * branch of that decision.
 */

const NOW = 1_700_000_000_000

function attachment(overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id: 'att-1',
    logSheetLocalId: 'sheet-local-1',
    logSheetServerId: '55',
    assetId: '7',
    fieldKey: 'pump_photo',
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 1234,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'pending',
    createdAt: NOW,
    ...overrides
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.attachments.clear()
  uploadAttachment.mockReset()
  uploadAttachment.mockResolvedValue({ id: 'att-1' })
})

describe('syncPendingAttachments', () => {
  it('uploads a queued file and marks it synced', async () => {
    await saveAttachment(attachment())

    const result = await syncPendingAttachments()

    expect(result).toEqual({ uploaded: 1, failed: 0, remaining: 0 })
    expect((await getAttachment('att-1'))?.syncStatus).toBe('synced')
  })

  it('sends the metadata the server needs to place the file', async () => {
    await saveAttachment(attachment({ width: 1600, height: 1200 }))
    await syncPendingAttachments()

    expect(uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'att-1',
        logSheetServerId: '55',
        assetId: '7',
        fieldKey: 'pump_photo',
        width: 1600,
        height: 1200
      })
    )
  })

  it('uploads one file at a time rather than in parallel', async () => {
    // Sequential is a deliberate choice for weak field links: three concurrent uploads there
    // are slower than one and far likelier to time out.
    let inFlight = 0
    let maxInFlight = 0
    uploadAttachment.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight--
    })

    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    await saveAttachment(attachment({ id: 'c' }))

    await syncPendingAttachments()
    expect(maxInFlight).toBe(1)
  })

  it('does nothing when the queue is empty', async () => {
    expect(await syncPendingAttachments()).toEqual({ uploaded: 0, failed: 0, remaining: 0 })
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  it('leaves a row untouched when the server is unreachable, so the next pass retries it', async () => {
    // ApiError status 0 is the client's own "transport died" signal. Marking this failed would
    // make a tunnel or a dropped Wi-Fi look like the server rejecting the photo.
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(0, 'خطا در ارتباط با سرور'))

    const result = await syncPendingAttachments()

    expect(result.uploaded).toBe(0)
    const row = await getAttachment('att-1')
    expect(row?.syncStatus).toBe('pending')
    expect(row?.syncError).toBeUndefined()
    expect(result.remaining).toBe(1)
  })

  it('stops the whole pass on a dead transport instead of hammering it', async () => {
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    await saveAttachment(attachment({ id: 'c' }))
    uploadAttachment.mockRejectedValue(new ApiError(0, 'offline'))

    await syncPendingAttachments()
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
  })

  it('records a 4xx rejection as failed — identical bytes get an identical refusal', async () => {
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(400, 'این فیلد پیوست نمی‌پذیرد'))

    const result = await syncPendingAttachments()

    expect(result.failed).toBe(1)
    const row = await getAttachment('att-1')
    expect(row?.syncStatus).toBe('failed')
    expect(row?.syncError).toBe('این فیلد پیوست نمی‌پذیرد')
  })

  it('keeps a 5xx retryable while still recording why it did not go', async () => {
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(503, 'سرویس در دسترس نیست'))

    const result = await syncPendingAttachments()

    // 'failed' is a retryable state here: getPendingAttachments picks failed rows back up.
    expect(result.failed).toBe(1)
    expect(result.remaining).toBe(1)
    expect((await getAttachment('att-1'))?.syncError).toBe('سرویس در دسترس نیست')
  })

  it('keeps a 401 retryable — an expired session is not a bad payload', async () => {
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(401, 'unauthorized'))

    const result = await syncPendingAttachments()
    expect(result.remaining).toBe(1)
  })

  it('stops retrying a file the server permanently refused', async () => {
    // The bug this pins down: classifying a failure as permanent is pointless unless the row
    // is actually taken out of the queue. Before this, a 400 was re-sent on every pass forever.
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(400, 'این فیلد پیوست نمی‌پذیرد'))

    const first = await syncPendingAttachments()
    expect(first.failed).toBe(1)
    expect(first.remaining).toBe(0) // parked — no longer counted as waiting

    const row = await getAttachment('att-1')
    expect(row?.permanentFailure).toBe(true)
    // The bytes are kept: the operator can still see the photo and decide what to do.
    expect(row?.blob).toBeInstanceOf(Blob)

    uploadAttachment.mockClear()
    const second = await syncPendingAttachments()
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(second).toEqual({ uploaded: 0, failed: 0, remaining: 0 })
  })

  it('keeps re-attempting a file that failed for a reason that might pass later', async () => {
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(503, 'سرویس در دسترس نیست'))

    await syncPendingAttachments()
    expect((await getAttachment('att-1'))?.permanentFailure).toBeUndefined()

    // Server recovers — the very next pass sends it, with no manual intervention.
    uploadAttachment.mockResolvedValue({ id: 'att-1' })
    expect(await syncPendingAttachments()).toEqual({ uploaded: 1, failed: 0, remaining: 0 })
  })

  it('re-queues a parked file once someone asks it to retry', async () => {
    await saveAttachment(attachment())
    uploadAttachment.mockRejectedValue(new ApiError(400, 'فیلد ناشناخته'))
    await syncPendingAttachments()

    // The escape hatch: the refusal was about server state (a field added after this tablet
    // last synced), not about the file, so re-queueing must actually work.
    await retryFailedAttachment('att-1')
    uploadAttachment.mockResolvedValue({ id: 'att-1' })

    expect(await syncPendingAttachments()).toEqual({ uploaded: 1, failed: 0, remaining: 0 })
    expect((await getAttachment('att-1'))?.syncStatus).toBe('synced')
  })

  it('clears the parked flag when an upload eventually succeeds', async () => {
    await saveAttachment(attachment({ permanentFailure: true, syncStatus: 'failed' }))
    await retryFailedAttachment('att-1')
    await syncPendingAttachments()

    const row = await getAttachment('att-1')
    expect(row?.syncStatus).toBe('synced')
    expect(row?.permanentFailure).toBeUndefined()
    expect(row?.syncError).toBeUndefined()
  })

  it('carries on after one file is rejected', async () => {
    await saveAttachment(attachment({ id: 'bad' }))
    await saveAttachment(attachment({ id: 'good' }))
    uploadAttachment.mockImplementation(async (args: { id: string }) => {
      if (args.id === 'bad') throw new ApiError(415, 'نوع فایل پشتیبانی نمی‌شود')
    })

    const result = await syncPendingAttachments()

    expect(result.uploaded).toBe(1)
    expect(result.failed).toBe(1)
    expect((await getAttachment('good'))?.syncStatus).toBe('synced')
  })

  it('does not attempt a file whose sheet has not synced yet', async () => {
    await saveAttachment(attachment({ logSheetServerId: undefined }))
    const result = await syncPendingAttachments()

    expect(uploadAttachment).not.toHaveBeenCalled()
    // Not counted as failed either — it is simply not this pass's work.
    expect(result).toEqual({ uploaded: 0, failed: 0, remaining: 0 })
  })

  it('stops immediately when the caller aborts', async () => {
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    const controller = new AbortController()
    controller.abort()

    await syncPendingAttachments(controller.signal)
    expect(uploadAttachment).not.toHaveBeenCalled()
  })
})
