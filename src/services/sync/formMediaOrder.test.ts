import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import { saveAttachment, getAttachment } from '@/services/storage/attachments'
import {
  correctRejectedForm,
  saveReviewedFormDraft,
  createLocalFormDraft,
  markFormSubmissionLocallyFinal
} from '@/services/storage/formSubmissions'
import { pushPendingFormFinals } from '@/services/sync/formSubmitSync'
import { mapFormFieldSnapshots, formSchemaEvidence } from '@/services/forms/mapFormFields'
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
    expect(await db.formSubmissions.get(row.id)).toMatchObject({syncStatus: 'failed', lastSubmitOutcome: 'VALIDATION_ERROR'})
    expect((await getAttachment('sig-1'))!.blob).toBeTruthy()
  })
})


it('recovers a refused photo, replaces it, and confirms only the new file on final', async () => {
  const draft = await createLocalFormDraft({
    formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
  })
  const original = { operatorSig: { type: 'attachment', ids: ['photo-A'] }, note: 'keep' }
  await saveAttachment(signature(draft.localId, 'photo-A'))
  await markFormSubmissionLocallyFinal(draft.localId, original)
  uploadAttachment.mockRejectedValueOnce(new ApiError(413, 'too large'))
  await pushPendingFormFinals()
  const corrected = await correctRejectedForm(draft.localId)
  expect(corrected?.formData).toEqual(original)
  await saveAttachment(signature(draft.localId, 'photo-B', { formSubmissionId: '12' }))
  const revised = { ...original, operatorSig: { type: 'attachment', ids: ['photo-B'] } }
  await markFormSubmissionLocallyFinal(draft.localId, revised)
  expect(await getAttachment('photo-A')).toMatchObject({pendingDelete: true})
  expect((await pushPendingFormFinals()).synced).toBe(1)
  expect(await getAttachment('photo-A')).toBeUndefined()
  expect(await getAttachment('photo-B')).toMatchObject({syncStatus: 'synced'})
  expect(submitFormFinal.mock.calls[0][0]).toMatchObject({ ...formSchemaEvidence(draft),
    requireUploadedMedia: true, formData: revised })
})

it('queues a scoped removal for a server-only photo when the replacement is saved', async () => {
  const draft = await createLocalFormDraft({
    formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1',
    fieldDefinitionsSnapshot: mapFormFieldSnapshots([{ id: 2, key: 'photo', dataType: 'image', label: 'Photo' }]),
    formData: { photo: { type: 'attachment', ids: ['remote'] } }
  })
  await db.formSubmissions.update(draft.id, { serverId: '12', serverStatus: 'DRAFT' })
  await markFormSubmissionLocallyFinal(draft.localId, {})
  expect(await getAttachment('remote')).toMatchObject({
    pendingDelete: true, fieldKey: 'photo', formSubmissionId: '12', formSubmissionLocalId: draft.localId
  })
  expect((await pushPendingFormFinals()).synced).toBe(1)
  expect(await getAttachment('remote')).toBeUndefined()
})

it('retains a legacy filing for correction when its draft request is definitively refused', async () => {
  const draft = await createLocalFormDraft({
    formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1',
    fieldDefinitionsSnapshot: mapFormFieldSnapshots([{ key: 'operatorSig', label: 'Photo', dataType: 'image' }])
  })
  const values = { operatorSig: { type: 'attachment', ids: ['photo-A'] } }
  await saveAttachment(signature(draft.localId, 'photo-A'))
  await markFormSubmissionLocallyFinal(draft.localId, values)
  upsertFormDraft.mockRejectedValue(new ApiError(400, 'Invalid draft'))
  await pushPendingFormFinals()
  await pushPendingFormFinals()
  expect(upsertFormDraft).toHaveBeenCalledTimes(1)
  expect(upsertFormDraft.mock.calls[0][0].legacyFields[0].id).toBeUndefined()
  expect(submitFormFinal).not.toHaveBeenCalled()
  expect((await correctRejectedForm(draft.localId))?.formData).toEqual(values)
  expect((await getAttachment('photo-A'))?.blob).toBeTruthy()
})

it('preserves a stale final until the operator reviews the server draft', async () => {
  const draft = await createLocalFormDraft({
    formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
  })
  await db.formSubmissions.update(draft.id, { serverId: '12', serverUpdatedAt: 10 })
  await markFormSubmissionLocallyFinal(draft.localId, { note: 'offline' })
  submitFormFinal.mockResolvedValueOnce({ submissionId: 12, outcome: 'CONFLICT' })
  await pushPendingFormFinals()
  await pushPendingFormFinals()
  expect(submitFormFinal).toHaveBeenCalledTimes(1)
  expect(submitFormFinal.mock.calls[0][0].expectedUpdatedAt).toBe(10)
  expect(await db.formSubmissions.get(draft.id)).toMatchObject({
    formData: { note: 'offline' }, syncConflict: true, serverUpdatedAt: 10
  })
  const remote = { id: 12, formDefinitionId: 10, reporterUnitId: 1, subjectUnitId: 1,
    status: 'DRAFT', formData: { note: 'from panel' }, updatedAt: 20 }
  const reviewed = await saveReviewedFormDraft(draft.localId, remote, { note: 'compared' }, '1')
  expect(reviewed).toMatchObject({ syncConflict: false, status: 'draft', serverUpdatedAt: 20 })
  await markFormSubmissionLocallyFinal(draft.localId, reviewed.formData)
  await pushPendingFormFinals()
  expect(submitFormFinal.mock.calls[1][0]).toMatchObject({ expectedUpdatedAt: 20, formData: { note: 'compared' } })
})
