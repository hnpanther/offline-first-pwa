import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { saveAttachment } from '@/services/storage/attachments'
import { syncPendingAttachments } from '@/services/sync/attachmentSync'
import { ATTACHMENT_ID_TAKEN, ATTACHMENT_ID_TAKEN_MESSAGE } from '@/services/sync/attachmentIdTaken'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import type { LocalAttachment, LogSheet } from '@/types'

const uploadAttachment = vi.fn()
vi.mock('@/services/api', () => ({
  uploadAttachment: (...a: unknown[]) => uploadAttachment(...a),
  deleteAttachment: vi.fn(),
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn()
}))

/**
 * Issue P-06 against backend B-10: an upload whose id the server already holds for somebody
 * else's file. The device re-mints the id once, points its round's answer at the new one and
 * delivers the file in the same pass; a second collision, or a round that can no longer carry a
 * changed answer to the server, parks the file with its reason — the bytes are never dropped.
 */

const USER = '7'
const LOCAL_ID = 'local-1'
const SERVER_ID = '55'
const ASSET = '7'
const FIELD = 'pump_photo'
const OLD_ID = '11111111-1111-4111-8111-111111111111'
const NOW = 1_800_000_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const taken = () =>
  new ApiError(409, 'شناسه‌ی این پیوست پیش‌تر برای فایل دیگری ثبت شده است', {
    message: 'شناسه‌ی این پیوست پیش‌تر برای فایل دیگری ثبت شده است',
    code: ATTACHMENT_ID_TAKEN
  })

function round(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: LOCAL_ID,
    localId: LOCAL_ID,
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: USER,
    localOwnerUserId: USER,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    entries: [
      {
        assetId: ASSET,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 41, [FIELD]: { type: 'attachment', ids: ['22222222-2222-4222-8222-222222222222', OLD_ID] } },
        locallyEditedAt: NOW - 60_000,
        createdAt: NOW - 600_000,
        updatedAt: NOW - 60_000
      }
    ],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides
  } as LogSheet
}

function photo(overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id: OLD_ID,
    createdByUserId: USER,
    logSheetLocalId: LOCAL_ID,
    logSheetServerId: SERVER_ID,
    assetId: ASSET,
    fieldKey: FIELD,
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    sizeBytes: 3,
    blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    syncStatus: 'pending',
    createdAt: NOW - 60_000,
    ...overrides
  } as LocalAttachment
}

async function only(): Promise<LocalAttachment> {
  const rows = await db.attachments.toArray()
  expect(rows).toHaveLength(1)
  return rows[0]
}

async function referencedIds(): Promise<unknown> {
  const sheet = await getLogSheet(LOCAL_ID)
  return (sheet!.entries[0].formData[FIELD] as { ids: string[] }).ids
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.attachments.clear()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(USER) })
  uploadAttachment.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

describe('an id somebody else already used (P-06)', () => {
  it('gives the file a fresh id, points the answer at it, and delivers it in the same pass', async () => {
    await saveLogSheet(round())
    await saveAttachment(photo())
    uploadAttachment.mockRejectedValueOnce(taken()).mockResolvedValueOnce({})

    const result = await syncPendingAttachments()

    expect(uploadAttachment).toHaveBeenCalledTimes(2)
    const newId = uploadAttachment.mock.calls[1][0].id
    expect(newId).toMatch(UUID)
    expect(newId).not.toBe(OLD_ID)
    expect(result.uploaded).toBe(1)

    const stored = await only()
    expect(stored).toMatchObject({ id: newId, idRemintedFrom: OLD_ID, syncStatus: 'synced' })
    expect(await db.attachments.get(OLD_ID)).toBeUndefined()
    // The sibling photograph's reference is untouched, and order is kept.
    expect(await referencedIds()).toEqual(['22222222-2222-4222-8222-222222222222', newId])
    // Marked edited, so the next progress push carries the new reference to the server.
    expect((await getLogSheet(LOCAL_ID))!.entries[0].locallyEditedAt).toBe(NOW)
    // The bytes travelled unchanged.
    expect(uploadAttachment.mock.calls[1][0].blob).toEqual(uploadAttachment.mock.calls[0][0].blob)
  })

  it('parks a second collision with its reason, keeping the bytes', async () => {
    await saveLogSheet(round())
    await saveAttachment(photo())
    uploadAttachment.mockRejectedValue(taken())

    await syncPendingAttachments()

    expect(uploadAttachment).toHaveBeenCalledTimes(2)
    const parked = await only()
    expect(parked.idRemintedFrom).toBe(OLD_ID)
    expect(parked).toMatchObject({
      syncStatus: 'failed',
      permanentFailure: true,
      failedStatus: 409,
      syncError: ATTACHMENT_ID_TAKEN_MESSAGE
    })
    expect(parked.blob).toBeDefined()
    // The answer names the row that holds the bytes — never an id nothing on the device has.
    expect(await referencedIds()).toContain(parked.id)

    // And a parked row is not offered again on the next pass.
    await syncPendingAttachments()
    expect(uploadAttachment).toHaveBeenCalledTimes(2)
  })

  it('parks instead of re-minting on a round the server already holds', async () => {
    await saveLogSheet(round({ status: 'submitted', syncStatus: 'synced', serverStatus: 'SUBMITTED' }))
    await saveAttachment(photo())
    uploadAttachment.mockRejectedValue(taken())

    await syncPendingAttachments()

    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    const parked = await only()
    expect(parked).toMatchObject({ id: OLD_ID, permanentFailure: true, failedStatus: 409 })
    expect(parked.idRemintedFrom).toBeUndefined()
    expect(await referencedIds()).toContain(OLD_ID)
  })

  it('re-mints on a completion not yet sent, so its submit carries the new id', async () => {
    await saveLogSheet(round({ status: 'submitted', syncStatus: 'pending', submittedAt: NOW - 1000 }))
    await saveAttachment(photo())
    uploadAttachment.mockRejectedValueOnce(taken()).mockResolvedValueOnce({})

    await syncPendingAttachments()

    const newId = (await only()).id
    const payload = toBatchPayload((await getLogSheet(LOCAL_ID))!)
    expect((payload.entries[0].formData[FIELD] as { ids: string[] }).ids).toContain(newId)
    expect((payload.entries[0].formData[FIELD] as { ids: string[] }).ids).not.toContain(OLD_ID)
  })

  it("rewrites the round's own answer for media that belongs to no asset", async () => {
    await saveLogSheet(round({ sheetFormData: { area_photo: { type: 'attachment', ids: [OLD_ID] } } }))
    await saveAttachment(photo({ assetId: undefined, fieldKey: 'area_photo' }))
    uploadAttachment.mockRejectedValueOnce(taken()).mockResolvedValueOnce({})

    await syncPendingAttachments()

    const newId = (await only()).id
    const sheet = (await getLogSheet(LOCAL_ID))!
    expect(sheet.sheetFormData).toEqual({ area_photo: { type: 'attachment', ids: [newId] } })
    expect(sheet.sheetFormLocallyEditedAt).toBe(NOW)
    // The asset's answer is not touched by a round-level file.
    expect(await referencedIds()).toContain(OLD_ID)
  })

  it('still retries a plain 409 — a full field — and never re-mints for it', async () => {
    await saveLogSheet(round())
    await saveAttachment(photo())
    uploadAttachment.mockRejectedValue(new ApiError(409, 'تعداد پیوست این فیلد به حد مجاز رسیده است'))

    await syncPendingAttachments()

    const row = await only()
    expect(row).toMatchObject({ id: OLD_ID, syncStatus: 'failed', failedStatus: 409 })
    expect(row.permanentFailure).toBeUndefined()
    expect(row.idRemintedFrom).toBeUndefined()
  })
})
