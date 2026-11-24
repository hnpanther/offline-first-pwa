import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import { saveAttachment, getAttachment } from '@/services/storage/attachments'
import {
  createLocalFormDraft,
  markFormSubmissionLocallyFinal
} from '@/services/storage/formSubmissions'
import { pushPendingFormFinals } from '@/services/sync/formSubmitSync'
import { formCanStillCarryAttachmentReference } from '@/services/sync/attachmentIdTaken'
import type { LocalAttachment } from '@/types'

const order: string[] = []
const upsertFormDraft = vi.fn()
const submitFormFinal = vi.fn()
const uploadAttachment = vi.fn()

vi.mock('@/services/api', () => ({
  upsertFormDraft: (...args: unknown[]) => upsertFormDraft(...args),
  submitFormFinal: (...args: unknown[]) => submitFormFinal(...args),
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  deleteRemoteAttachment: vi.fn()
}))

vi.mock('@/services/auth/sessionContext', () => ({
  getSessionUserId: vi.fn(async () => 'user-1')
}))

function signature(localId: string, id = 'sig-1', extra: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id,
    formSubmissionLocalId: localId,
    fieldKey: 'operatorSig',
    kind: 'IMAGE',
    mimeType: 'image/png',
    sizeBytes: 8,
    blob: new Blob(['png'], { type: 'image/png' }),
    syncStatus: 'pending',
    createdAt: 1,
    createdByUserId: 'user-1',
    ...extra
  }
}

beforeEach(async () => {
  order.length = 0
  upsertFormDraft.mockReset()
  submitFormFinal.mockReset()
  uploadAttachment.mockReset()
  upsertFormDraft.mockImplementation(async () => {
    order.push('draft')
    return { outcome: 'OK', submissionId: 12, status: 'DRAFT' }
  })
  uploadAttachment.mockImplementation(async () => {
    order.push('upload')
    return { id: 'sig-1' }
  })
  submitFormFinal.mockImplementation(async () => {
    order.push('submit')
    return { outcome: 'OK', submissionId: 12, status: 'SUBMITTED' }
  })
  if (!db.isOpen()) await db.open()
  await db.formSubmissions.clear()
  await db.attachments.clear()
  await db.logSheets.clear()
})

describe('form final waits for signature and other media', () => {
  it('upserts a draft, uploads the signature, then submits', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '1',
      fieldDefinitionsSnapshot: [],
      formData: {}
    })
    await saveAttachment(signature(row.localId))
    await markFormSubmissionLocallyFinal(row.localId, {
      operatorSig: { type: 'signature', ids: ['sig-1'], signedAt: 1 }
    })

    await saveAttachment({
      ...signature('other', 'sheet-photo'),
      formSubmissionLocalId: undefined,
      logSheetLocalId: 'sheet-local',
      logSheetServerId: '9',
      assetId: '1',
      fieldKey: 'photo'
    })

    const result = await pushPendingFormFinals()
    expect(order).toEqual(['draft', 'upload', 'submit'])
    expect(result.synced).toBe(1)
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(uploadAttachment.mock.calls[0][0]).toMatchObject({ formSubmissionId: '12' })
    const stored = await db.formSubmissions.get(row.id)
    expect(stored?.formData).toMatchObject({ operatorSig: { ids: ['sig-1'] } })
    expect(await getAttachment('sig-1')).toMatchObject({ syncStatus: 'synced' })
    expect(await getAttachment('sheet-photo')).toMatchObject({ syncStatus: 'pending' })
  })

  it('does not submit, and does not mark the signature lost, when the upload is refused', async () => {
    uploadAttachment.mockImplementation(async () => {
      order.push('upload')
      throw new ApiError(409, 'Submitted form cannot be edited.')
    })
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '1',
      fieldDefinitionsSnapshot: [],
      formData: {}
    })
    await db.formSubmissions.update(row.id, { serverId: '12', serverStatus: 'DRAFT' })
    await saveAttachment(signature(row.localId, 'sig-1', { formSubmissionId: '12' }))
    await markFormSubmissionLocallyFinal(row.localId, {
      operatorSig: { type: 'signature', ids: ['sig-1'], signedAt: 1 }
    })

    const result = await pushPendingFormFinals()
    expect(order).toEqual(['upload'])
    expect(submitFormFinal).not.toHaveBeenCalled()
    expect(result.synced).toBe(0)
    const stored = await db.formSubmissions.get(row.id)
    expect(stored?.status).toBe('submitted')
    expect(stored?.syncStatus).toBe('pending')
    expect(stored?.formData).toMatchObject({ operatorSig: { ids: ['sig-1'] } })
    const sig = await getAttachment('sig-1')
    expect(sig?.blob).toBeTruthy()
    expect(sig?.permanentFailure).toBeUndefined()
    expect(sig?.id).toBe('sig-1')
  })

  it('still lets a not-yet-accepted final carry a new signature id', () => {
    expect(
      formCanStillCarryAttachmentReference({ syncStatus: 'pending', serverStatus: 'DRAFT' })
    ).toBe(true)
    expect(
      formCanStillCarryAttachmentReference({ syncStatus: 'pending', serverStatus: undefined })
    ).toBe(true)
    expect(
      formCanStillCarryAttachmentReference({ syncStatus: 'synced', serverStatus: 'SUBMITTED' })
    ).toBe(false)
  })
})


describe('form final media failure recovery', () => {
  it('submits the updated reference after an attachment id collision', async () => {
    uploadAttachment.mockRejectedValueOnce(new ApiError(409, 'taken', { code: 'ATTACHMENT_ID_TAKEN' }))
    const row = await createLocalFormDraft({
      formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
    })
    await saveAttachment(signature(row.localId))
    await markFormSubmissionLocallyFinal(row.localId, {
      operatorSig: { type: 'signature', ids: ['sig-1'], signedAt: 1 }
    })
    await pushPendingFormFinals()
    const stored = (await db.formSubmissions.get(row.id))!
    expect(submitFormFinal).toHaveBeenCalledTimes(1)
    expect(submitFormFinal.mock.calls[0][0].formData).toEqual(stored.formData)
    expect(submitFormFinal.mock.calls[0][0].formData.operatorSig.ids).not.toContain('sig-1')
  })

  it('never treats a permanently refused upload as delivered', async () => {
    uploadAttachment.mockRejectedValue(new ApiError(413, 'too large'))
    const row = await createLocalFormDraft({
      formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
    })
    await saveAttachment(signature(row.localId))
    await markFormSubmissionLocallyFinal(row.localId, {
      operatorSig: { type: 'signature', ids: ['sig-1'], signedAt: 1 }
    })
    await pushPendingFormFinals()
    await pushPendingFormFinals()
    expect(submitFormFinal).not.toHaveBeenCalled()
    expect((await db.formSubmissions.get(row.id))!.syncStatus).toBe('pending')
    expect((await getAttachment('sig-1'))!.blob).toBeTruthy()
  })
})
