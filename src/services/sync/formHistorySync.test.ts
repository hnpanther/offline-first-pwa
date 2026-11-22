import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { createLocalFormDraft, saveLocalFormDraft } from '@/services/storage/formSubmissions'
import { mergeOwnFormHistory } from '@/services/sync/formHistorySync'
import type { FormSubmissionDto } from '@/services/api'

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.formSubmissions.clear()
})

function dto(overrides: Partial<FormSubmissionDto> = {}): FormSubmissionDto {
  return {
    id: 12,
    formDefinitionId: 10,
    status: 'APPROVED',
    reporterUnitId: 1,
    subjectUnitId: 1,
    formData: { note: 'from-server' },
    localId: 'remote-1',
    reportedByUserId: 'user-1',
    submittedAt: 50,
    ...overrides
  }
}

describe('form history merge', () => {
  it('records an approved filing the device did not have, and a voided one', async () => {
    const titles = new Map([['10', { title: 'HSE / گزارش تخلف', code: 'HSE' }]])
    await mergeOwnFormHistory(
      [dto(), dto({ id: 13, localId: 'remote-2', status: 'VOIDED' })],
      titles,
      'user-1'
    )
    const rows = await db.formSubmissions.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.serverId === '12')).toMatchObject({
      serverStatus: 'APPROVED',
      status: 'submitted',
      syncStatus: 'synced',
      formTitle: 'HSE / گزارش تخلف'
    })
    expect(rows.find(r => r.serverId === '13')?.serverStatus).toBe('VOIDED')
  })

  it('does not overwrite a draft the operator is still filling', async () => {
    const draft = await createLocalFormDraft({
      formDefinitionId: '10',
      reporterUnitId: '1',
      subjectUnitId: '1',
      fieldDefinitionsSnapshot: [],
      formData: { note: 'mine' }
    })
    await saveLocalFormDraft(draft.localId, { note: 'mine' })
    await mergeOwnFormHistory(
      [dto({ localId: draft.localId, status: 'SUBMITTED', formData: { note: 'server' } })],
      new Map(),
      'user-1'
    )
    const stored = await db.formSubmissions.get(draft.id)
    expect(stored?.status).toBe('draft')
    expect(stored?.formData).toEqual({ note: 'mine' })
  })
})
