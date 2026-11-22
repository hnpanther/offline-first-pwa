import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, updateLogSheet } from '@/services/storage'
import { syncManager, REFUSED_PASSES_BEFORE_SHOWING, type SyncEvent } from '@/services/sync'
import { isUndeliveredRound } from '@/services/sync/undelivered'
import { ApiError } from '@/services/api/client'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import type { LogSheet } from '@/types'

const submitLogSheetsBatch = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...a: unknown[]) => submitLogSheetsBatch(...a),
  pushLogSheetProgressBatch: vi.fn().mockResolvedValue([]),
  reportSyncBacklog: vi.fn().mockResolvedValue(undefined),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn()
}))

/**
 * Issue P-04 through the real `SyncManager`, on a real (fake) IndexedDB: the queue goes out in
 * requests of twenty, a `413` is split rather than repeated, a refusal is neither silent for ever
 * nor a reason to stop delivering everything else, and a dead link still loses nothing. Plus the
 * device half of P-05: what `kept: false` (backend V26) leaves on the row.
 */

const USER = '7'
const NOW = 1_800_000_000_000
type BatchItem = { localId: string; serverId: number }

function completed(i: number, overrides: Partial<LogSheet> = {}): LogSheet {
  const localId = `local-${i}`
  return {
    id: localId,
    localId,
    serverId: String(100 + i),
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: USER,
    localOwnerUserId: USER,
    status: 'submitted',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: `action-${i}`,
    completedAt: NOW - 60_000,
    submittedAt: NOW - 60_000,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 40 + i },
        locallyEditedAt: NOW - 120_000,
        createdAt: NOW - 600_000,
        updatedAt: NOW - 120_000
      }
    ],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides
  } as LogSheet
}

async function queue(count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await saveLogSheet(completed(i))
}

async function row(i: number): Promise<LogSheet> {
  const found = await getLogSheet(`local-${i}`)
  if (!found) throw new Error(`local-${i} disappeared — that is data loss`)
  return found
}

const accepted = (items: BatchItem[]) =>
  items.map(item => ({ localId: item.localId, serverId: item.serverId, outcome: 'SUBMITTED' }))

function recordEvents(): SyncEvent[] {
  const events: SyncEvent[] = []
  syncManager.subscribe(e => void events.push(e))
  return events
}

/** One clean pass, so a count of refused passes left by an earlier case starts again at zero. */
async function startFromACleanPass(): Promise<void> {
  await queue(1)
  submitLogSheetsBatch.mockImplementationOnce(async (items: BatchItem[]) => accepted(items))
  await syncManager.sync()
  await db.logSheets.clear()
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.attachments.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(USER) })
  await db.syncMeta.put({
    key: 'authSession',
    value: {
      accessToken: 'token',
      tokenType: 'Bearer',
      expiresAt: NOW + 86_400_000,
      username: 'op',
      fullName: 'اپراتور',
      roles: ['OPERATOR'],
      permissions: ['POST:/api/log-sheets/batch']
    }
  })
  submitLogSheetsBatch.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubGlobal('navigator', { onLine: true })
})

describe('the queue goes out in pieces (P-04)', () => {
  it('sends 45 completed rounds as three requests and records every answer', async () => {
    await queue(45)
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) => accepted(items))

    await syncManager.sync()

    expect(submitLogSheetsBatch.mock.calls.map(c => c[0].length)).toEqual([20, 20, 5])
    for (let i = 1; i <= 45; i++) expect((await row(i)).syncStatus).toBe('synced')
  })

  it('retries a request of 20 the server calls too large as two of 10', async () => {
    await queue(20)
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) => {
      if (items.length > 10) throw new ApiError(413, 'Payload Too Large')
      return accepted(items)
    })

    await syncManager.sync()

    expect(submitLogSheetsBatch.mock.calls.map(c => c[0].length)).toEqual([20, 10, 10])
    for (let i = 1; i <= 20; i++) expect((await row(i)).syncStatus).toBe('synced')
  })

  it('marks the one round too large on its own, keeps it, and delivers the rest', async () => {
    await queue(4)
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) => {
      if (items.some(item => item.localId === 'local-3')) throw new ApiError(413, 'Payload Too Large')
      return accepted(items)
    })

    await syncManager.sync()

    const tooLarge = await row(3)
    expect(tooLarge.syncStatus).toBe('failed')
    expect(tooLarge.syncError).toBe(SYNC_OUTCOME_MESSAGES.TOO_LARGE)
    // Kept on the device, and counted as undelivered — never quietly purged.
    expect(tooLarge.entries[0].formData).toEqual({ temp: 43 })
    expect(isUndeliveredRound(tooLarge, NOW)).toBe(true)
    for (const i of [1, 2, 4]) expect((await row(i)).syncStatus).toBe('synced')
  })

  it('keeps what an earlier request delivered when the link dies on a later one', async () => {
    await queue(25)
    let call = 0
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) => {
      if (++call === 2) throw new ApiError(0, 'ارتباط با سرور برقرار نشد.')
      return accepted(items)
    })

    await syncManager.sync()

    const statuses = await Promise.all(Array.from({ length: 25 }, (_, i) => row(i + 1)))
    expect(statuses.filter(s => s.syncStatus === 'synced')).toHaveLength(20)
    expect(statuses.filter(s => s.syncStatus === 'pending')).toHaveLength(5)
  })
})

describe('a refusal is not a network blip (P-04)', () => {
  it('keeps the rounds pending and flashes nothing for a dead link', async () => {
    await queue(2)
    submitLogSheetsBatch.mockRejectedValue(new ApiError(0, 'ارتباط با سرور برقرار نشد.'))
    const events = recordEvents()

    await syncManager.sync()

    expect(events.filter(e => e.type === 'error').every(e => e.transient === true)).toBe(true)
    expect((await row(1)).syncStatus).toBe('pending')
    expect((await row(2)).syncStatus).toBe('pending')
  })

  it(`says so after ${REFUSED_PASSES_BEFORE_SHOWING} refused passes in a row, and leaves the rounds pending`, async () => {
    await startFromACleanPass()
    await queue(2)
    submitLogSheetsBatch.mockRejectedValue(new ApiError(400, 'درخواست نامعتبر است.'))
    const events = recordEvents()

    for (let pass = 1; pass <= REFUSED_PASSES_BEFORE_SHOWING; pass++) {
      await syncManager.sync()
      const shown = events.filter(e => e.type === 'error' && e.transient === false)
      expect(shown).toHaveLength(pass < REFUSED_PASSES_BEFORE_SHOWING ? 0 : 1)
    }

    const shown = events.find(e => e.type === 'error' && e.transient === false)
    expect(shown?.error).toBe('درخواست نامعتبر است.')
    // Never failed by the device: a fix on the server releases them on the next pass.
    expect((await row(1)).syncStatus).toBe('pending')
    expect((await row(2)).syncStatus).toBe('pending')

    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) => accepted(items))
    await syncManager.sync()
    expect((await row(1)).syncStatus).toBe('synced')
  })

  it('treats a gateway with no backend behind it as transient', async () => {
    await startFromACleanPass()
    await queue(1)
    submitLogSheetsBatch.mockRejectedValue(new ApiError(502, 'Bad Gateway'))
    const events = recordEvents()

    for (let pass = 0; pass < REFUSED_PASSES_BEFORE_SHOWING + 1; pass++) await syncManager.sync()

    expect(events.some(e => e.type === 'error' && e.transient === false)).toBe(false)
    expect((await row(1)).syncStatus).toBe('pending')
  })
})

describe('kept: false (P-05, backend V26)', () => {
  it('is recorded, and makes a SUPERSEDED round count as undelivered', async () => {
    await queue(1)
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) =>
      items.map(item => ({ localId: item.localId, serverId: item.serverId, outcome: 'SUPERSEDED', kept: false }))
    )

    await syncManager.sync()

    const refused = await row(1)
    expect(refused.syncStatus).toBe('failed')
    expect(refused.serverKeepRefusedAt).toBe(NOW)
    expect(refused.serverKeptAt).toBeUndefined()
    expect(isUndeliveredRound(refused, NOW)).toBe(true)
  })

  it('is replaced by a later kept: true, and the other way round', async () => {
    await queue(1)
    submitLogSheetsBatch.mockImplementationOnce(async (items: BatchItem[]) =>
      items.map(item => ({ localId: item.localId, serverId: item.serverId, outcome: 'SUPERSEDED', kept: false }))
    )
    await syncManager.sync()

    // The operator re-sends (a correction) and this time it is kept.
    await updateLogSheet('local-1', { syncStatus: 'pending' })
    submitLogSheetsBatch.mockImplementationOnce(async (items: BatchItem[]) =>
      items.map(item => ({ localId: item.localId, serverId: item.serverId, outcome: 'SUPERSEDED', kept: true }))
    )
    await syncManager.sync()

    const kept = await row(1)
    expect(kept.serverKeptAt).toBe(NOW)
    expect(kept.serverKeepRefusedAt).toBeUndefined()
    expect(isUndeliveredRound(kept, NOW)).toBe(false)
  })

  it('an answer that says neither leaves what an earlier answer said', async () => {
    await saveLogSheet(completed(1, { serverKeptAt: NOW - 1000 }))
    submitLogSheetsBatch.mockImplementation(async (items: BatchItem[]) =>
      items.map(item => ({ localId: item.localId, serverId: item.serverId, outcome: 'EXPIRED' }))
    )

    await syncManager.sync()

    expect((await row(1)).serverKeptAt).toBe(NOW - 1000)
  })
})
