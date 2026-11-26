import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { fetchFormHistoryPage, type FormSubmissionDto } from '@/services/api'
import { pullOwnFormHistory } from './formHistorySync'

vi.mock('@/services/api', async original => ({
  ...await original<typeof import('@/services/api')>(),
  fetchFormHistoryPage: vi.fn()
}))

const fetchPage = vi.mocked(fetchFormHistoryPage)
const checkpoint = 'form-history:7'

function draft(id: number): FormSubmissionDto {
  return { id, formDefinitionId: 1, status: 'DRAFT', reporterUnitId: 1, subjectUnitId: 1,
    reportedByUserId: 7, formData: { n: id } }
}

beforeEach(async () => {
  await db.open()
  await db.formSubmissions.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: 7 })
  fetchPage.mockReset()
})

describe('incremental form history', () => {
  it('resumes after the last committed page and requests only newer changes after the fence', async () => {
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 1, through: 2, hasMore: true, items: [draft(10)] })
      .mockRejectedValueOnce(new Error('offline'))
    await pullOwnFormHistory()
    expect(await db.formSubmissions.count()).toBe(1)
    const first = (await db.syncMeta.get(checkpoint))?.value
    expect(first).toMatchObject({ after: 1, since: expect.any(Number), through: 2 })
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 2, through: 2, hasMore: false, items: [draft(20)] })
    await pullOwnFormHistory()
    expect(fetchPage).toHaveBeenLastCalledWith(first, undefined)
    expect(await db.formSubmissions.count()).toBe(2)
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 2, through: 2, hasMore: false, items: [] })
    await pullOwnFormHistory()
    expect(fetchPage).toHaveBeenLastCalledWith({ after: 2, since: 0 }, undefined)
  })

  it('rolls back rows and cursor together if saving the checkpoint fails', async () => {
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 1, through: 1, hasMore: false, items: [draft(10)] })
    const put = vi.spyOn(db.syncMeta, 'put').mockRejectedValueOnce(new Error('disk full'))
    try {
      await pullOwnFormHistory()
      expect(await db.formSubmissions.count()).toBe(0)
      expect(await db.syncMeta.get(checkpoint)).toBeUndefined()
    } finally {
      put.mockRestore()
    }
  })

  it('does not advance the old user cursor after a login switch or malformed page', async () => {
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 0, through: 1, hasMore: true, items: [draft(10)] })
    await pullOwnFormHistory()
    fetchPage.mockImplementationOnce(async () => {
      await db.syncMeta.put({ key: 'sessionUserId', value: 8 })
      return { ownerId: 7, next: 1, through: 1, hasMore: false, items: [draft(10)] }
    })
    await pullOwnFormHistory()
    expect(await db.formSubmissions.count()).toBe(0)
    expect(await db.syncMeta.get(checkpoint)).toBeUndefined()
  })

  it('keeps reopened drafts and skips terminal history past retention even if reviewed today', async () => {
    fetchPage.mockResolvedValueOnce({ ownerId: 7, next: 2, through: 2, hasMore: false, items: [
      { ...draft(10), status: 'APPROVED', syncedAt: 1, updatedAt: Date.now() }, draft(20)
    ] })
    await pullOwnFormHistory()
    expect((await db.formSubmissions.toArray()).map(r => r.serverId)).toEqual(['20'])
  })
})
