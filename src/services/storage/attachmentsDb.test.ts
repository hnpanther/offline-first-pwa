import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import {
  ATTACHMENT_RETENTION_MS,
  bindAttachmentsToServerSheet,
  deleteAttachment,
  deleteAttachmentsForLogSheet,
  deleteSyncedAttachmentsForLogSheet,
  getAttachment,
  getAttachmentsByIds,
  getAttachmentsForEntry,
  getPendingAttachments,
  markAttachmentFailed,
  markAttachmentSynced,
  purgeSyncedAttachmentBlobs,
  saveAttachment
} from '@/services/storage/attachments'
import type { LocalAttachment } from '@/types'

/** Whoever is holding the tablet. Captured media is owned per row, not per sheet. */
const OWNER = '9'

/**
 * Exercises the attachment table against a real IndexedDB implementation.
 *
 * These functions decide when captured media is kept and when it is thrown away, so they are
 * worth testing for real rather than against a hand-rolled fake: the failure mode is an
 * operator's evidence disappearing, which no amount of type-checking catches.
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
})

describe('basic persistence', () => {
  it('stores and reads back an attachment, blob included', async () => {
    await saveAttachment(attachment())
    const stored = await getAttachment('att-1')
    expect(stored?.fieldKey).toBe('pump_photo')
    expect(stored?.blob).toBeInstanceOf(Blob)
  })

  it('reads a set of ids and silently skips ones that are gone', async () => {
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b' }))
    const rows = await getAttachmentsByIds(['a', 'missing', 'b'])
    expect(rows.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('returns nothing for an empty id list without touching the database', async () => {
    expect(await getAttachmentsByIds([])).toEqual([])
  })

  it('finds an entry’s attachments in capture order', async () => {
    await saveAttachment(attachment({ id: 'second', createdAt: NOW + 1000 }))
    await saveAttachment(attachment({ id: 'first', createdAt: NOW }))
    await saveAttachment(attachment({ id: 'other-field', fieldKey: 'other' }))
    await saveAttachment(attachment({ id: 'other-asset', assetId: '9' }))

    const rows = await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo', OWNER)
    expect(rows.map(r => r.id)).toEqual(['first', 'second'])
  })

  it('matches an asset id regardless of whether it was stored as a number or a string', async () => {
    // Ids arrive as numbers from the server bundle and as strings from the form tree; the
    // lookup has to see those as the same asset or an operator's photo goes missing.
    await saveAttachment(attachment({ id: 'n', assetId: 7 as unknown as string }))
    expect(await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo', OWNER)).toHaveLength(1)
  })

  it('finds media answering the round’s own question, which has no asset at all', async () => {
    // The round's own form: `assetId` absent is a real owner, not a missing value. Both sides
    // of the comparison go through `toIdString`, so absent matches absent and nothing else —
    // an asset id is a database id and can never be the empty string.
    await saveAttachment(attachment({ id: 'round-level', assetId: undefined }))
    await saveAttachment(attachment({ id: 'per-asset', assetId: '7' }))

    const roundLevel = await getAttachmentsForEntry(
      'sheet-local-1', undefined, 'pump_photo', OWNER)
    expect(roundLevel.map(r => r.id)).toEqual(['round-level'])

    // And the two owners do not see each other's files, which is what keeps the per-field
    // ceiling from counting one against the other.
    const perAsset = await getAttachmentsForEntry('sheet-local-1', '7', 'pump_photo', OWNER)
    expect(perAsset.map(r => r.id)).toEqual(['per-asset'])
  })

  it('still owns round-level media per operator', async () => {
    // The invariant that cost the most to learn, applied to the new owner: a reassigned round
    // reuses the local row, so «what is on this device for this field» is a different question
    // from «what is mine». Answering the first where the second was meant handed one
    // operator's photographs to the next.
    await saveAttachment(attachment({ id: 'mine', assetId: undefined, createdByUserId: OWNER }))
    await saveAttachment(attachment({ id: 'theirs', assetId: undefined, createdByUserId: '42' }))

    const rows = await getAttachmentsForEntry('sheet-local-1', undefined, 'pump_photo', OWNER)
    expect(rows.map(r => r.id)).toEqual(['mine'])
  })

  it('deletes one attachment', async () => {
    await saveAttachment(attachment())
    await deleteAttachment('att-1')
    expect(await getAttachment('att-1')).toBeUndefined()
  })
})

describe('getPendingAttachments', () => {
  it('returns rows waiting to upload, including ones that failed before', async () => {
    await saveAttachment(attachment({ id: 'pending' }))
    await saveAttachment(attachment({ id: 'failed', syncStatus: 'failed' }))
    await saveAttachment(attachment({ id: 'done', syncStatus: 'synced' }))

    const ids = (await getPendingAttachments()).map(r => r.id).sort()
    expect(ids).toEqual(['failed', 'pending'])
  })

  it('skips a row whose sheet has not synced yet', async () => {
    // The server keys an attachment to a log sheet, so there is nowhere to put this one yet.
    // Uploading it would 404; skipping keeps it queued until the sheet gets its id.
    await saveAttachment(attachment({ id: 'unbound', logSheetServerId: undefined }))
    expect(await getPendingAttachments()).toEqual([])
  })

  it('skips a row whose bytes were already reclaimed', async () => {
    await saveAttachment(attachment({ id: 'no-bytes', blob: undefined }))
    expect(await getPendingAttachments()).toEqual([])
  })
})

describe('sync status transitions', () => {
  it('clears a previous error when an upload finally succeeds', async () => {
    await saveAttachment(attachment())
    await markAttachmentFailed('att-1', 'خطای شبکه')
    expect((await getAttachment('att-1'))?.syncError).toBe('خطای شبکه')

    await markAttachmentSynced('att-1', NOW + 5000)
    const row = await getAttachment('att-1')
    expect(row?.syncStatus).toBe('synced')
    expect(row?.syncError).toBeUndefined()
    expect(row?.uploadedAt).toBe(NOW + 5000)
  })
})

describe('purgeSyncedAttachmentBlobs', () => {
  it('drops the bytes of a long-since-uploaded file but keeps the row', async () => {
    await saveAttachment(
      attachment({ syncStatus: 'synced', uploadedAt: NOW - ATTACHMENT_RETENTION_MS - 1 })
    )

    expect(await purgeSyncedAttachmentBlobs(ATTACHMENT_RETENTION_MS, NOW)).toBe(1)
    const row = await getAttachment('att-1')
    // The row survives so the field still shows the attachment; opening it re-fetches.
    expect(row).toBeDefined()
    expect(row?.blob).toBeUndefined()
    expect(row?.syncStatus).toBe('synced')
  })

  it('keeps the bytes of a file uploaded recently', async () => {
    await saveAttachment(attachment({ syncStatus: 'synced', uploadedAt: NOW - 1000 }))
    expect(await purgeSyncedAttachmentBlobs(ATTACHMENT_RETENTION_MS, NOW)).toBe(0)
    expect((await getAttachment('att-1'))?.blob).toBeInstanceOf(Blob)
  })

  it('never touches a file that has not reached the server', async () => {
    // This is the one that matters: purging a pending blob destroys the only copy.
    await saveAttachment(attachment({ syncStatus: 'pending', createdAt: 0 }))
    await saveAttachment(attachment({ id: 'f', syncStatus: 'failed', createdAt: 0 }))

    expect(await purgeSyncedAttachmentBlobs(ATTACHMENT_RETENTION_MS, NOW)).toBe(0)
    expect((await getAttachment('att-1'))?.blob).toBeInstanceOf(Blob)
    expect((await getAttachment('f'))?.blob).toBeInstanceOf(Blob)
  })

  it('falls back to the capture time when the upload time was never recorded', async () => {
    await saveAttachment({
      ...attachment({ syncStatus: 'synced', createdAt: NOW - ATTACHMENT_RETENTION_MS - 1 }),
      uploadedAt: undefined
    })
    expect(await purgeSyncedAttachmentBlobs(ATTACHMENT_RETENTION_MS, NOW)).toBe(1)
  })
})

describe('bindAttachmentsToServerSheet', () => {
  it('stamps the server id onto every attachment of a sheet raised offline', async () => {
    await saveAttachment(attachment({ id: 'a', logSheetServerId: undefined }))
    await saveAttachment(attachment({ id: 'b', logSheetServerId: undefined }))
    await saveAttachment(
      attachment({ id: 'other', logSheetLocalId: 'sheet-local-2', logSheetServerId: undefined })
    )

    expect(await getPendingAttachments()).toEqual([])
    await bindAttachmentsToServerSheet('sheet-local-1', '99')

    const pending = await getPendingAttachments()
    expect(pending.map(r => r.id).sort()).toEqual(['a', 'b'])
    expect(pending.every(r => r.logSheetServerId === '99')).toBe(true)
    // The other sheet is untouched — binding is per sheet, not global.
    expect((await getAttachment('other'))?.logSheetServerId).toBeUndefined()
  })
})

describe('deleting a sheet’s attachments', () => {
  it('removes everything when local work is discarded outright', async () => {
    await saveAttachment(attachment({ id: 'a' }))
    await saveAttachment(attachment({ id: 'b', syncStatus: 'synced' }))
    await deleteAttachmentsForLogSheet('sheet-local-1')
    expect(await db.attachments.count()).toBe(0)
  })

  it('retires only the uploaded ones when the sheet is aged out by cleanup', async () => {
    await saveAttachment(attachment({ id: 'uploaded', syncStatus: 'synced' }))
    await saveAttachment(attachment({ id: 'waiting' }))
    await saveAttachment(attachment({ id: 'failed', syncStatus: 'failed' }))

    expect(await deleteSyncedAttachmentsForLogSheet('sheet-local-1')).toBe(1)

    // The two that never reached the server survive: they carry their own server sheet id, so
    // the queue can still deliver them long after the local sheet row is gone.
    const left = await db.attachments.toArray()
    expect(left.map(r => r.id).sort()).toEqual(['failed', 'waiting'])
  })

  it('also drops a parked file, which has nowhere left to be seen or retried from', async () => {
    // Parked = the server refused it and the queue no longer picks it up. Once the sheet row
    // is gone there is no screen to view it on and no retry button to reach, so keeping the
    // bytes would leak storage with no path back.
    await saveAttachment(
      attachment({ id: 'parked', syncStatus: 'failed', permanentFailure: true })
    )
    await saveAttachment(attachment({ id: 'waiting' }))

    expect(await deleteSyncedAttachmentsForLogSheet('sheet-local-1')).toBe(1)
    expect(await getAttachment('parked')).toBeUndefined()
    expect(await getAttachment('waiting')).toBeDefined()
  })

  it('keeps a voided round’s photograph the server refused, whatever happens to the sheet', async () => {
    // Parked by a 403 only for a voided round whose evidence the server would not take (an older
    // server, or the wrong deploy order). That refusal is about the server, not the file, and the
    // bytes are the only copy — PWA roadmap §16 promised they would never be deleted.
    await saveAttachment(
      attachment({ id: 'void-evidence', syncStatus: 'failed', permanentFailure: true, failedStatus: 403 })
    )
    await saveAttachment(
      attachment({ id: 'refused-file', syncStatus: 'failed', permanentFailure: true, failedStatus: 400 })
    )

    expect(await deleteSyncedAttachmentsForLogSheet('sheet-local-1')).toBe(1)
    expect(await getAttachment('void-evidence')).toBeDefined()
    expect(await getAttachment('refused-file')).toBeUndefined()
  })

  it('leaves another sheet’s uploaded attachments alone', async () => {
    await saveAttachment(attachment({ id: 'mine', syncStatus: 'synced' }))
    await saveAttachment(
      attachment({ id: 'theirs', logSheetLocalId: 'sheet-local-2', syncStatus: 'synced' })
    )
    await deleteSyncedAttachmentsForLogSheet('sheet-local-1')
    expect(await getAttachment('theirs')).toBeDefined()
  })
})
