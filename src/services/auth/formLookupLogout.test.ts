import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { applyPage } from '@/services/lookups/lookupStore'
import { syncRequiredLookups } from '@/services/lookups/lookupSync'
import type { LookupDevicePage } from '@/services/api'
import {
  loadRequiredFormLookups,
  loginLookupLease,
  saveRequiredFormLookups
} from '@/services/forms/formLookups'
import { clearUserSessionContext, getSessionUserId, setSessionUserId } from '@/services/auth/sessionContext'
import { saveAttachment, getAttachment } from '@/services/storage/attachments'
import {
  createLocalFormDraft,
  getFormSubmissionsForUser,
  getPendingFormDrafts,
  getPendingFormFinals,
  markFormSubmissionLocallyFinal
} from '@/services/storage/formSubmissions'
import type { LocalAttachment } from '@/types'

const T0 = 1_800_000_000_000
const HOUR = 3_600_000

function page(code: string, itemId: number, label: string): LookupDevicePage {
  return {
    code,
    name: label,
    revision: 4,
    serverTime: T0,
    leaseUntil: T0 + 24 * HOUR,
    columns: [],
    items: [{ id: itemId, code: `${code}-1`, label, active: true, attributes: {}, updatedAt: 1 }],
    hasMore: false,
    nextSince: 1,
    nextAfterId: itemId
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.lookupLists.clear()
  await db.lookupItems.clear()
  await db.formSubmissions.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
})

afterEach(async () => {
  await db.lookupLists.clear()
  await db.lookupItems.clear()
  await db.formSubmissions.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
})

describe('logout clears form lookups the same way as round lookups', () => {
  it('drops leased form items and round items, and the form lease key, and keeps drafts, finals and signatures', async () => {
    await setSessionUserId('7')
    await applyPage(page('STAFF', 1, 'علی'), 4, T0)
    await applyPage(page('PUMP', 2, 'پمپ'), 4, T0)
    await saveRequiredFormLookups([{ code: 'STAFF', name: 'پرسنل', revision: 4 }])

    const draft = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '1',
      fieldDefinitionsSnapshot: [],
      formData: { note: 'still here' }
    })
    const queued = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '1',
      fieldDefinitionsSnapshot: [],
      formData: {}
    })
    const finalised = await markFormSubmissionLocallyFinal(queued.localId, {
      operatorSig: { type: 'signature', ids: ['sig-1'], signedAt: 1 }
    })
    const signature: LocalAttachment = {
      id: 'sig-1',
      formSubmissionLocalId: queued.localId,
      fieldKey: 'operatorSig',
      kind: 'IMAGE',
      mimeType: 'image/png',
      sizeBytes: 4,
      blob: new Blob(['png'], { type: 'image/png' }),
      syncStatus: 'pending',
      createdAt: 1,
      createdByUserId: '7'
    }
    await saveAttachment(signature)

    await clearUserSessionContext()

    expect(await db.lookupLists.count()).toBe(0)
    expect(await db.lookupItems.count()).toBe(0)
    expect(await loadRequiredFormLookups()).toEqual([])
    expect(await getSessionUserId()).toBeNull()

    expect(await db.formSubmissions.get(draft.id)).toMatchObject({
      status: 'draft',
      formData: { note: 'still here' }
    })
    expect(await getPendingFormDrafts('7')).toHaveLength(1)
    expect(finalised?.status).toBe('submitted')
    expect(await getPendingFormFinals('7')).toHaveLength(1)
    const kept = await getAttachment('sig-1')
    expect(kept?.blob).toBeInstanceOf(Blob)
    expect(kept?.syncStatus).toBe('pending')
  })

  it('history stays limited to the owner and the accessible units after the lists are gone', async () => {
    await setSessionUserId('7')
    const own = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '2',
      fieldDefinitionsSnapshot: [],
      formData: { note: 'own' }
    })
    const otherUnit = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '90',
      subjectUnitId: '91',
      fieldDefinitionsSnapshot: [],
      formData: { note: 'elsewhere' }
    })
    await clearUserSessionContext()

    const listed = await getFormSubmissionsForUser('7', { accessibleUnitIds: ['1', '2'] })
    const ids = listed.map(r => r.localId)
    expect(ids).toContain(own.localId)
    expect(ids).not.toContain(otherUnit.localId)

    const stranger = await getFormSubmissionsForUser('8', { accessibleUnitIds: ['1', '2'] })
    expect(stranger.map(r => r.localId)).not.toContain(own.localId)
  })
})

describe('offline lookup download', () => {
  it('keeps only round lists unioned with FILL-form lists, not every catalog', async () => {
    await applyPage(page('STAFF', 1, 'علی'), 4, T0)
    await applyPage(page('PUMP', 2, 'پمپ'), 4, T0)
    await applyPage(page('EVERY_CATALOG', 3, 'همه'), 4, T0)

    const result = await syncRequiredLookups(
      loginLookupLease(
        [{ code: 'PUMP', name: 'پمپ', revision: 4 }],
        [{ code: 'STAFF', name: 'پرسنل', revision: 4 }]
      ),
      T0 + HOUR,
      async () => page('STAFF', 1, 'علی')
    )

    expect(result.dropped).toEqual(['EVERY_CATALOG'])
    expect(await db.lookupLists.get('staff')).toBeTruthy()
    expect(await db.lookupLists.get('pump')).toBeTruthy()
    expect(await db.lookupLists.get('every_catalog')).toBeUndefined()
    expect(await db.lookupItems.where('listId').equals('every_catalog').count()).toBe(0)
  })
})
