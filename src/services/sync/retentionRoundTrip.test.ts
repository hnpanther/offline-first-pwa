import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { pullBootstrap } from '@/services/sync/pullBootstrap'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import type { LogSheet } from '@/types'

const fetchBootstrap = vi.fn()
vi.mock('@/services/api', () => ({
  fetchBootstrap: (...args: unknown[]) => fetchBootstrap(...args)
}))

/**
 * Backend roadmap §41, end to end on the device: what the panel's three settings say, as they
 * arrive on `/api/bootstrap`, is what the local purge then does — including the administrator
 * changing their mind, and a tablet that reconnects to an older server.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

function refusedRound(localId: string, submittedAgoMs: number): LogSheet {
  return {
    id: localId,
    localId,
    serverId: localId.replace(/\D/g, '') || '1',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: '7',
    localOwnerUserId: '7',
    status: 'submitted',
    syncStatus: 'failed',
    serverStatus: 'EXPIRED',
    submittedAt: NOW - submittedAgoMs,
    entries: [],
    createdAt: NOW - submittedAgoMs,
    updatedAt: NOW - submittedAgoMs
  } as LogSheet
}

function payload(deviceRetention?: unknown) {
  return {
    serverTime: NOW,
    userId: 7,
    operationalUnits: [],
    accessibleUnitIds: [],
    supervisorScopeUnitIds: [],
    primaryUnitId: null,
    ...(deviceRetention === undefined ? {} : { deviceRetention })
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.settings.clear()
  await db.syncMeta.clear()
  fetchBootstrap.mockReset()
})

describe('the panel decides, the tablet follows', () => {
  it('an upgraded server with the defaults stops the week-old purge of a refused round', async () => {
    // Before the server sends anything, this round would go after 7 days…
    await saveLogSheet(refusedRound('local-1', 8 * DAY))
    // …but the server's first bootstrap arrives first.
    fetchBootstrap.mockResolvedValue(
      payload({ syncedRetentionHours: 24, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 168 })
    )
    await pullBootstrap()

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await getLogSheet('local-1')).toBeDefined()
  })

  it('switching the purge on in the panel reaches the purge on the next bootstrap, and off again', async () => {
    await saveLogSheet(refusedRound('local-1', 4 * DAY))

    fetchBootstrap.mockResolvedValue(
      payload({ syncedRetentionHours: 24, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 })
    )
    await pullBootstrap()
    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await getLogSheet('local-1')).toBeUndefined()

    // The administrator changes their mind; a round refused later must now stay.
    await saveLogSheet(refusedRound('local-2', 4 * DAY))
    fetchBootstrap.mockResolvedValue(
      payload({ syncedRetentionHours: 24, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 72 })
    )
    await pullBootstrap()
    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await getLogSheet('local-2')).toBeDefined()
  })

  it('a tablet that goes back to an older server keeps the last policy it saw', async () => {
    fetchBootstrap.mockResolvedValue(
      payload({ syncedRetentionHours: 24, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 168 })
    )
    await pullBootstrap()

    fetchBootstrap.mockResolvedValue(payload())
    await pullBootstrap()

    await saveLogSheet(refusedRound('local-1', 30 * DAY))
    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })

  it('a tablet that has only ever known an older server keeps today\'s behaviour', async () => {
    fetchBootstrap.mockResolvedValue(payload())
    await pullBootstrap()

    await saveLogSheet(refusedRound('local-1', 8 * DAY))
    await saveLogSheet(refusedRound('local-2', 6 * DAY))
    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await getLogSheet('local-1')).toBeUndefined()
    expect(await getLogSheet('local-2')).toBeDefined()
  })
})
