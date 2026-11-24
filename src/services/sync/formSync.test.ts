import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import {
  applyFormDraftSyncResult,
  applyFormFinalSyncResult,
  createLocalFormDraft,
  getFormSubmissionsForUser,
  getPendingFormDrafts,
  getPendingFormFinals,
  isFormDraftOwnedByUser,
  isFormFinalOwnedByUser,
  isFormSubmissionOutboundOwnedByUser,
  markFormSubmissionLocallyFinal,
  saveLocalFormDraft
} from '@/services/storage/formSubmissions'
import { loginLookupLease, mergeRequiredLookups } from '@/services/forms/formLookups'
import {
  describeFormSubmitBlockingIssues,
  findFormSubmitBlockingIssues
} from '@/utils/formSubmissionValidation'
import type { FieldDefinition } from '@/types/sync'

vi.mock('@/services/auth/sessionContext', () => ({
  getSessionUserId: vi.fn(async () => 'user-1')
}))

const field = (overrides: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: 'f1',
  classId: '',
  key: 'note',
  label: 'یادداشت',
  dataType: 'text',
  required: true,
  order: 0,
  version: 1,
  deleted: false,
  synced: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides
})

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.formSubmissions.clear()
  await db.formDefinitions.clear()
})

afterEach(async () => {
  await db.formSubmissions.clear()
})

describe('form shared-tablet ownership', () => {
  it('refuses outbound push when another user owns the row', () => {
    expect(
      isFormSubmissionOutboundOwnedByUser({ createdByUserId: 'user-2' }, 'user-1')
    ).toBe(false)
    expect(
      isFormSubmissionOutboundOwnedByUser({ createdByUserId: 'user-1' }, 'user-1')
    ).toBe(true)
    expect(isFormSubmissionOutboundOwnedByUser({}, 'user-1')).toBe(true)
    expect(isFormSubmissionOutboundOwnedByUser({ createdByUserId: 'user-1' }, null)).toBe(false)
  })

  it('draft lane ignores another user and already-mirrored edits', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    expect(isFormDraftOwnedByUser(row, 'user-1')).toBe(true)
    expect(isFormDraftOwnedByUser(row, 'user-2')).toBe(false)

    await applyFormDraftSyncResult(row.localId, {
      serverId: '99',
      outcome: 'OK',
      editedAt: row.locallyEditedAt
    })
    const after = (await db.formSubmissions.get(row.id))!
    expect(isFormDraftOwnedByUser(after, 'user-1')).toBe(false)

    await saveLocalFormDraft(row.localId, { note: 'x' })
    const dirty = (await db.formSubmissions.get(row.id))!
    expect(isFormDraftOwnedByUser(dirty, 'user-1')).toBe(true)
  })

  it('final lane only queues submitted pending rows for the owner', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    expect(isFormFinalOwnedByUser(row, 'user-1')).toBe(false)
    const finalised = await markFormSubmissionLocallyFinal(row.localId, { note: 'done' })
    expect(finalised?.status).toBe('submitted')
    expect(isFormFinalOwnedByUser(finalised!, 'user-1')).toBe(true)
    expect(isFormFinalOwnedByUser(finalised!, 'user-2')).toBe(false)
  })
})

describe('form draft offline → online', () => {
  it('keeps a draft locally and stamps serverId on OK without touching syncStatus', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()],
      formData: { note: 'partial' }
    })
    expect(row.syncStatus).toBe('pending')
    const pending = await getPendingFormDrafts('user-1')
    expect(pending.map(p => p.localId)).toContain(row.localId)

    await applyFormDraftSyncResult(row.localId, {
      serverId: '42',
      outcome: 'OK',
      editedAt: row.locallyEditedAt
    })
    const after = (await db.formSubmissions.get(row.id))!
    expect(after.serverId).toBe('42')
    expect(after.serverStatus).toBe('DRAFT')
    expect(after.status).toBe('draft')
    // Draft lane must never mark final-submit fields failed/synced from a draft answer.
    expect(after.syncStatus).toBe('pending')
    expect(after.draftSyncStatus).toBe('synced')
  })
})

describe('form final idempotency', () => {
  it('treats DUPLICATE like OK and never discards the local row on VALIDATION_ERROR', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    await markFormSubmissionLocallyFinal(row.localId, { note: 'done' })

    await applyFormFinalSyncResult(row.localId, {
      serverId: '7',
      outcome: 'DUPLICATE'
    })
    let after = (await db.formSubmissions.get(row.id))!
    expect(after.syncStatus).toBe('synced')
    expect(after.serverStatus).toBe('SUBMITTED')
    expect(after.lastSubmitOutcome).toBe('DUPLICATE')

    // Reset to failed path
    await db.formSubmissions.update(row.id, { syncStatus: 'pending', status: 'submitted' })
    await applyFormFinalSyncResult(row.localId, {
      outcome: 'VALIDATION_ERROR',
      message: 'required'
    })
    after = (await db.formSubmissions.get(row.id))!
    expect(after.syncStatus).toBe('failed')
    expect(after.formData).toEqual({ note: 'done' })
    expect(await getPendingFormFinals('user-1')).toHaveLength(1)
  })
})

describe('lookup lease merge', () => {
  it('login downloads only round lists unioned with FILL-able form lists', () => {
    const lease = loginLookupLease(
      [{ code: 'PUMP', name: 'پمپ', revision: 2 }],
      [{ code: 'STAFF', name: 'پرسنل', revision: 4 }]
    )
    expect(lease.map(l => l.code).sort()).toEqual(['PUMP', 'STAFF'])
    expect(lease.map(l => l.code)).not.toContain('EVERY_CATALOG')
  })

  it('unions round and form lookups keeping the higher revision', () => {
    const merged = mergeRequiredLookups(
      [{ code: 'STAFF', name: 'پرسنل', revision: 3 }],
      [
        { code: 'STAFF', name: 'پرسنل', revision: 12 },
        { code: 'CONTRACTOR', name: 'پیمانکار', revision: 1 }
      ]
    )
    expect(merged).toEqual(
      expect.arrayContaining([
        { code: 'STAFF', name: 'پرسنل', revision: 12 },
        { code: 'CONTRACTOR', name: 'پیمانکار', revision: 1 }
      ])
    )
    expect(merged).toHaveLength(2)
  })
})

describe('form final validation', () => {
  it('blocks missing required fields and describes them in Persian', () => {
    const issues = findFormSubmitBlockingIssues([field()], {})
    expect(issues).toHaveLength(1)
    expect(describeFormSubmitBlockingIssues(issues)).toContain('یادداشت')
    expect(findFormSubmitBlockingIssues([field()], { note: 'ok' })).toHaveLength(0)
  })
})

describe('form list unit isolation', () => {
  it('does not list a row whose units are outside the session scope', async () => {
    const visible = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    const leaked = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '90',
      subjectUnitId: '91',
      fieldDefinitionsSnapshot: [field()]
    })
    const listed = await getFormSubmissionsForUser('user-1', {
      accessibleUnitIds: ['1', '2']
    })
    const ids = listed.map(r => r.localId)
    expect(ids).toContain(visible.localId)
    expect(ids).not.toContain(leaked.localId)
  })
})

describe('form final approve/void forward-compat', () => {
  it('stores APPROVED from the wire without breaking the synced lane', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    await markFormSubmissionLocallyFinal(row.localId, { note: 'done' })
    await applyFormFinalSyncResult(row.localId, {
      serverId: '7',
      outcome: 'OK',
      status: 'APPROVED'
    })
    const after = (await db.formSubmissions.get(row.id))!
    expect(after.syncStatus).toBe('synced')
    expect(after.serverStatus).toBe('APPROVED')
  })

  it('ignores an unknown future status string and still marks synced', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [field()]
    })
    await markFormSubmissionLocallyFinal(row.localId, { note: 'done' })
    await applyFormFinalSyncResult(row.localId, {
      serverId: '8',
      outcome: 'OK',
      status: 'SOMETHING_NEW'
    })
    const after = (await db.formSubmissions.get(row.id))!
    expect(after.syncStatus).toBe('synced')
    expect(after.serverStatus).toBe('SUBMITTED')
  })
})


describe('form delivery regression tests', () => {
  it('preserves a save racing an older acknowledgement', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1',
      fieldDefinitionsSnapshot: [], formData: { note: 'old' }
    })
    await Promise.all([
      saveLocalFormDraft(row.localId, { note: 'new' }),
      applyFormDraftSyncResult(row.localId, {
        outcome: 'OK', serverId: '42', editedAt: row.locallyEditedAt
      })
    ])
    const saved = (await db.formSubmissions.get(row.id))!
    expect(saved.formData).toEqual({ note: 'new' })
    expect(saved.serverId).toBe('42')
    expect(isFormDraftOwnedByUser(saved, 'user-1')).toBe(true)
  })

  it('keeps saves dirty when the clock does not advance', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      const row = await createLocalFormDraft({
        formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
      })
      await applyFormDraftSyncResult(row.localId, { outcome: 'OK', editedAt: 100 })
      const saved = await saveLocalFormDraft(row.localId, { note: 'new' })
      expect(saved!.locallyEditedAt).toBeGreaterThan(100)
      expect(isFormDraftOwnedByUser(saved!, 'user-1')).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  it('requeues interrupted delivery only for the owner with the same action id', async () => {
    const row = await createLocalFormDraft({
      formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '1', fieldDefinitionsSnapshot: []
    })
    const final = await markFormSubmissionLocallyFinal(row.localId, { note: 'done' })
    await db.formSubmissions.update(row.id, { syncStatus: 'syncing' })
    expect((await getPendingFormFinals('user-1'))[0].clientActionId).toBe(final!.clientActionId)
    expect(await getPendingFormFinals('user-2')).toHaveLength(0)
  })
})


it('saves a corrected filing unit and mirrors subject without losing answers', async () => {
  const row = await createLocalFormDraft({
    formDefinitionId: '10', reporterUnitId: '1', subjectUnitId: '2', fieldDefinitionsSnapshot: []
  })
  await saveLocalFormDraft(row.localId, { note: 'preserved' }, '3')
  const saved = (await db.formSubmissions.get(row.id))!
  expect(saved.reporterUnitId).toBe('3')
  expect(saved.subjectUnitId).toBe('3')
  expect(saved.formData).toEqual({ note: 'preserved' })
  expect(isFormDraftOwnedByUser(saved, 'user-1')).toBe(true)
})
