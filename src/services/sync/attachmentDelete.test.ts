import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import {
  getAttachment,
  getAttachmentsByIds,
  getAttachmentsForEntry,
  getPendingAttachmentDeletes,
  getPendingAttachments,
  markAttachmentPendingDelete,
  markAttachmentSynced,
  removeAttachment,
  saveAttachment
} from '@/services/storage/attachments'
import { saveLogSheet } from '@/services/storage'
import { syncPendingAttachments } from '@/services/sync/attachmentSync'
import type { LocalAttachment, LogSheet } from '@/types'

const uploadAttachment = vi.fn()
const deleteRemoteAttachment = vi.fn()
vi.mock('@/services/api', () => ({
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  deleteRemoteAttachment: (...args: unknown[]) => deleteRemoteAttachment(...args)
}))

/**
 * Removing a file the server already has.
 *
 * The bug this exists for: deleting an attachment only ever removed the device's row, while the
 * server kept counting its own copy against the per-field ceiling. So an operator who deleted a
 * photo and took another was refused — the field looked to have a free slot and the server knew
 * it did not — and because the refusal was a 4xx the replacement was then parked for good. With
 * audio and video, whose ceiling is one, a single retake was enough to lock the field.
 *
 * The rule these cases pin down: **before the sheet is submitted a deletion goes to the server
 * too; afterwards it does not.** Delivered evidence must survive somebody tidying their tablet.
 */

const NOW = 1_700_000_000_000
const SHEET_SERVER_ID = '55'

function attachment(overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id: 'att-1',
    logSheetLocalId: 'sheet-local-1',
    logSheetServerId: SHEET_SERVER_ID,
    assetId: '7',
    fieldKey: 'pump_photo',
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 1234,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'synced',
    uploadedAt: NOW,
    createdAt: NOW,
    ...overrides
  }
}

const SESSION_USER_ID = '7'

/**
 * The sheet, owned by whoever is signed in. Ownership matters here because a deletion that
 * reaches the server goes out under the current operator's token, exactly like an upload —
 * see `attachmentOwnership.test.ts`.
 */
async function seedSheet(status: LogSheet['status']): Promise<void> {
  await saveLogSheet({
    localId: 'sheet-local-1',
    serverId: SHEET_SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: '',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status,
    syncStatus: status === 'submitted' ? 'synced' : 'pending',
    entries: [],
    createdAt: NOW,
    updatedAt: NOW
  } as unknown as Parameters<typeof saveLogSheet>[0])
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.attachments.clear()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  uploadAttachment.mockReset()
  uploadAttachment.mockResolvedValue({ id: 'att-1' })
  deleteRemoteAttachment.mockReset()
  deleteRemoteAttachment.mockResolvedValue(undefined)
})

describe('marking a file for deletion', () => {
  it('hides it from every read path immediately, network or not', async () => {
    // The operator tapped delete. Whatever happens with the server afterwards, the file is
    // gone from their point of view now — an item that lingers on screen reads as a failure.
    await saveAttachment(attachment())

    await markAttachmentPendingDelete('att-1')

    expect(await getAttachmentsByIds(['att-1'])).toEqual([])
    expect(await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo')).toEqual([])
  })

  it('takes it out of the upload queue', async () => {
    // Otherwise the upload pass could re-send the very file the delete pass is about to remove.
    await saveAttachment(attachment({ syncStatus: 'pending' }))

    await markAttachmentPendingDelete('att-1')

    expect(await getPendingAttachments()).toEqual([])
  })

  it('keeps the row itself, because the deletion is pending work', async () => {
    await saveAttachment(attachment())

    await markAttachmentPendingDelete('att-1')

    expect(await getAttachment('att-1')).toBeDefined()
    expect((await getPendingAttachmentDeletes()).map(r => r.id)).toEqual(['att-1'])
  })

  it('ignores a row the server never received — there is nothing to delete there', async () => {
    await saveAttachment(attachment({ logSheetServerId: undefined, syncStatus: 'pending' }))

    await markAttachmentPendingDelete('att-1')

    expect(await getPendingAttachmentDeletes()).toEqual([])
  })
})

describe('deciding what a delete means, from the database rather than the screen', () => {
  it('queues a server deletion for a file that is already synced', async () => {
    await saveAttachment(attachment({ syncStatus: 'synced' }))

    expect(await removeAttachment('att-1')).toBe('queued')
    expect((await getPendingAttachmentDeletes()).map(r => r.id)).toEqual(['att-1'])
  })

  it('queues a deletion for a row still marked pending — the server may already have it', async () => {
    // The question is "might the server have this", not "do we know it does", and the two differ
    // exactly when it matters: an upload whose response never arrived — a timeout, a 502, a link
    // that dropped after the server committed — leaves the row `pending` here while the file
    // sits on the server. Taking the local-only path there orphans the server's copy, and since
    // the server counts its own rows against the per-field ceiling a one-clip field is then full
    // forever with nothing the operator can delete. Reached in the field on a one-video field.
    await saveAttachment(attachment({ syncStatus: 'pending' }))

    expect(await removeAttachment('att-1')).toBe('queued')
    expect((await getPendingAttachmentDeletes()).map(r => r.id)).toEqual(['att-1'])
  })

  it('queues one for a failed row too — a refusal is not proof the file is absent', async () => {
    await saveAttachment(attachment({ syncStatus: 'failed' }))

    expect(await removeAttachment('att-1')).toBe('queued')
    expect((await getPendingAttachmentDeletes()).map(r => r.id)).toEqual(['att-1'])
  })

  it('reads the row fresh, so a stale screen cannot orphan the server copy', async () => {
    // The defect this exists for, caught only in a live run. The component holds `items` from
    // its last render; the upload queue flips rows to `synced` in the background. Deleting a
    // photo taken a minute earlier therefore consulted a snapshot still saying `pending`, took
    // the local-only path, and left the server's copy behind — recreating the very divergence
    // the whole mechanism removes. Passing the row in is what made that possible; re-reading
    // it is what makes it impossible.
    await saveAttachment(attachment({ syncStatus: 'pending' }))
    // What the sync pass does, invisibly to any component that rendered before it.
    await markAttachmentSynced('att-1')

    expect(await removeAttachment('att-1')).toBe('queued')
    expect(await getAttachment('att-1')).toBeDefined()
  })

  it('drops a synced row that the server was never told about', async () => {
    // No server id means it was never uploaded, whatever the status says; queueing a deletion
    // for it would leave a row waiting on a request that can never be made.
    await saveAttachment(attachment({ syncStatus: 'synced', logSheetServerId: undefined }))

    expect(await removeAttachment('att-1')).toBe('dropped')
    expect(await getAttachment('att-1')).toBeUndefined()
  })
})

describe('draining deletions on an unsubmitted sheet', () => {
  it('deletes on the server and drops the local row', async () => {
    // The whole point: this is what frees the slot the server counts.
    await seedSheet('draft')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')

    const result = await syncPendingAttachments()

    expect(deleteRemoteAttachment).toHaveBeenCalledWith('att-1', undefined)
    expect(result.deleted).toBe(1)
    expect(await getAttachment('att-1')).toBeUndefined()
  })

  it('runs before the uploads, so a replacement taken after the delete fits on the same pass', async () => {
    // At the ceiling, order decides whether the replacement is accepted now or refused and
    // left for the next pass.
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'old', syncStatus: 'synced' }))
    await saveAttachment(attachment({ id: 'new', syncStatus: 'pending' }))
    await markAttachmentPendingDelete('old')

    const order: string[] = []
    deleteRemoteAttachment.mockImplementation(async () => {
      order.push('delete')
    })
    uploadAttachment.mockImplementation(async () => {
      order.push('upload')
      return { id: 'new' }
    })

    await syncPendingAttachments()

    expect(order).toEqual(['delete', 'upload'])
  })

  it('treats an already-absent file as done rather than retrying it forever', async () => {
    await seedSheet('draft')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')
    deleteRemoteAttachment.mockRejectedValue(new ApiError(404, 'Attachment not found.'))

    const result = await syncPendingAttachments()

    expect(result.deleted).toBe(1)
    expect(await getAttachment('att-1')).toBeUndefined()
  })

  it('keeps the deletion queued when the device is offline', async () => {
    // status 0 is "the request never reached anyone". Dropping the row here would forget the
    // deletion and leave the server's copy consuming a slot with nothing left to retry.
    await seedSheet('draft')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')
    deleteRemoteAttachment.mockRejectedValue(new ApiError(0, 'offline'))

    const result = await syncPendingAttachments()

    expect(result.deleted).toBe(0)
    expect(await getAttachment('att-1')).toBeDefined()
    expect((await getPendingAttachmentDeletes()).map(r => r.id)).toEqual(['att-1'])
  })

  it('keeps it queued when the server refuses the deletion', async () => {
    await seedSheet('draft')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')
    deleteRemoteAttachment.mockRejectedValue(new ApiError(403, 'not allowed'))

    await syncPendingAttachments()

    expect(await getAttachment('att-1')).toBeDefined()
  })

  it('delivers the deletion on a later pass once the link is back', async () => {
    await seedSheet('draft')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')
    deleteRemoteAttachment.mockRejectedValueOnce(new ApiError(0, 'offline'))

    await syncPendingAttachments()
    expect(await getAttachment('att-1')).toBeDefined()

    deleteRemoteAttachment.mockResolvedValue(undefined)
    const second = await syncPendingAttachments()

    expect(second.deleted).toBe(1)
    expect(await getAttachment('att-1')).toBeUndefined()
  })
})

describe('draining deletions on a submitted sheet', () => {
  it('never touches the server copy — that is delivered evidence', async () => {
    await seedSheet('submitted')
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')

    const result = await syncPendingAttachments()

    expect(deleteRemoteAttachment).not.toHaveBeenCalled()
    // The local row still goes: the operator asked for it gone from their device.
    expect(result.deleted).toBe(1)
    expect(await getAttachment('att-1')).toBeUndefined()
  })

  it('treats a sheet the device no longer has as submitted', async () => {
    // Cleanup only retires sheets that reached a terminal state, so "no local row" almost
    // always means delivered and purged. Guessing this way costs a stale file; guessing the
    // other way costs evidence.
    await saveAttachment(attachment())
    await markAttachmentPendingDelete('att-1')

    await syncPendingAttachments()

    expect(deleteRemoteAttachment).not.toHaveBeenCalled()
    expect(await getAttachment('att-1')).toBeUndefined()
  })
})

describe('the counted state after a delete', () => {
  it('frees the slot on the device the moment the operator deletes', async () => {
    // What the ceiling is judged against locally. Before the fix this number and the server's
    // diverged permanently on the first delete.
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    await saveAttachment(attachment({ id: 'c' }))
    expect(await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo')).toHaveLength(3)

    await markAttachmentPendingDelete('b')

    expect(await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo')).toHaveLength(2)
  })

  it('counts attachments this form value never referenced', async () => {
    // A photo added from the web panel or another device belongs to the same (sheet, asset,
    // field) and the server counts it. Counting only what the local form value references is
    // how the device came to believe a full field was not full.
    await saveAttachment(attachment({ id: 'mine' }))
    await saveAttachment(attachment({ id: 'from-elsewhere' }))

    const forField = await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo')

    expect(forField.map(r => r.id).sort()).toEqual(['from-elsewhere', 'mine'])
  })

  it('does not mix up fields or assets', async () => {
    await saveAttachment(attachment({ id: 'photo', fieldKey: 'pump_photo' }))
    await saveAttachment(attachment({ id: 'note', fieldKey: 'pump_audio', kind: 'AUDIO' }))
    await saveAttachment(attachment({ id: 'other-asset', assetId: '99' }))

    const forField = await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo')

    expect(forField.map(r => r.id)).toEqual(['photo'])
  })
})

describe('a refusal about state, not about the file', () => {
  it('keeps a file refused for "field is full" in the queue instead of parking it', async () => {
    // 409 is the server saying "not right now". The bytes are fine, and a slot frees the moment
    // a queued deletion lands — which is exactly the sequence the original bug produced.
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'replacement', syncStatus: 'pending' }))
    uploadAttachment.mockRejectedValue(
      new ApiError(409, 'تعداد پیوست این فیلد به حد مجاز رسیده است (حداکثر 3).')
    )

    await syncPendingAttachments()

    const row = await getAttachment('replacement')
    expect(row?.syncStatus).toBe('failed')
    expect(row?.permanentFailure).toBeUndefined()
    // Still queued, so the next pass tries again with no operator action.
    expect((await getPendingAttachments()).map(r => r.id)).toEqual(['replacement'])
  })

  it('shows the server\'s own words rather than a generic message', async () => {
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'replacement', syncStatus: 'pending' }))
    uploadAttachment.mockRejectedValue(
      new ApiError(409, 'تعداد پیوست این فیلد به حد مجاز رسیده است (حداکثر 3).')
    )

    await syncPendingAttachments()

    expect((await getAttachment('replacement'))?.syncError).toContain('حد مجاز')
  })

  it('still parks a refusal that is about the file itself', async () => {
    // The distinction has to keep working in both directions: 400 means the same bytes will be
    // refused forever, and retrying those is what parking exists to prevent.
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'bad', syncStatus: 'pending' }))
    uploadAttachment.mockRejectedValue(new ApiError(400, 'Unsupported attachment file type.'))

    await syncPendingAttachments()

    expect((await getAttachment('bad'))?.permanentFailure).toBe(true)
    expect(await getPendingAttachments()).toEqual([])
  })

  it('uploads the replacement once the slot is freed, all in one pass', async () => {
    // End to end, and the exact scenario reported: three photos, delete one, take another.
    await seedSheet('draft')
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    await saveAttachment(attachment({ id: 'c' }))
    await saveAttachment(attachment({ id: 'd', syncStatus: 'pending' }))
    await markAttachmentPendingDelete('b')

    let serverCount = 3
    deleteRemoteAttachment.mockImplementation(async () => {
      serverCount--
    })
    uploadAttachment.mockImplementation(async () => {
      if (serverCount >= 3) {
        throw new ApiError(409, 'تعداد پیوست این فیلد به حد مجاز رسیده است (حداکثر 3).')
      }
      serverCount++
      return { id: 'd' }
    })

    const result = await syncPendingAttachments()

    expect(result.deleted).toBe(1)
    expect(result.uploaded).toBe(1)
    expect(serverCount).toBe(3)
    expect((await getAttachment('d'))?.syncStatus).toBe('synced')
  })
})
