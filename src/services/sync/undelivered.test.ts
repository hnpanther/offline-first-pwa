import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { saveLogSheet } from '@/services/storage'
import {
  computeUndeliveredBacklog,
  isLateProgressDue,
  isUndeliveredRound,
  latestEditMarker
} from '@/services/sync/undelivered'
import { reportUndeliveredBacklogIfChanged } from '@/services/sync/backlogReport'
import type { LogSheet } from '@/types'

const reportSyncBacklog = vi.fn()
vi.mock('@/services/api', () => ({
  reportSyncBacklog: (...a: unknown[]) => reportSyncBacklog(...a)
}))

/**
 * The one definition of "a round whose readings the server has received in no form" — read by the
 * dashboard, the device-check page and the report to the panel (backend V25). Each case is a row
 * shape the app actually writes.
 */

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function row(overrides: Partial<LogSheet>): LogSheet {
  return {
    id: 'x',
    localId: overrides.localId ?? 'x',
    serverId: '1',
    templateId: '1',
    templateName: 't',
    scopeSummary: '',
    status: 'submitted',
    syncStatus: 'failed',
    entries: [],
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    ...overrides
  } as LogSheet
}

const edited = (at: number) => [{
  assetId: '1', assetName: 'a', subFunctionCode: '', subFunctionTag: '', classId: '1',
  formData: { temp: 1 }, locallyEditedAt: at, createdAt: at, updatedAt: at
}]

describe('isUndeliveredRound — submitted rounds', () => {
  it('a delivered round is not', () => {
    expect(isUndeliveredRound(row({ syncStatus: 'synced' }), NOW)).toBe(false)
  })
  it('a round still in the queue is not — that is the pending badge', () => {
    expect(isUndeliveredRound(row({ syncStatus: 'pending' }), NOW)).toBe(false)
    expect(isUndeliveredRound(row({ syncStatus: 'syncing' }), NOW)).toBe(false)
  })
  it('a refusal the server kept is not', () => {
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'EXPIRED', serverKeptAt: NOW }), NOW)).toBe(false)
    // SUPERSEDED and CANCELLED have been kept as void submissions since V14.
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'SUPERSEDED' }), NOW)).toBe(false)
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'CANCELLED' }), NOW)).toBe(false)
  })
  it('a refusal nothing kept is', () => {
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'EXPIRED' }), NOW)).toBe(true)
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'VALIDATION_ERROR' }), NOW)).toBe(true)
    expect(isUndeliveredRound(row({ lastSubmitOutcome: 'ERROR' }), NOW)).toBe(true)
    // A row an older app failed locally, with no server outcome at all.
    expect(isUndeliveredRound(row({}), NOW)).toBe(true)
  })
  it('an archived snapshot is never counted — it lives in its own store', () => {
    expect(isUndeliveredRound(row({ localId: 'archive:1:7' }), NOW)).toBe(false)
  })
})

describe('isUndeliveredRound — drafts', () => {
  it('an open draft with edits is ordinary progress, not undelivered', () => {
    expect(isUndeliveredRound(row({
      status: 'draft', syncStatus: 'pending', serverStatus: 'IN_PROGRESS',
      dueAt: NOW + HOUR, entries: edited(NOW - HOUR)
    }), NOW)).toBe(false)
  })
  it('an expired draft with no edits of its own has nothing to lose', () => {
    expect(isUndeliveredRound(row({
      status: 'draft', syncStatus: 'pending', serverStatus: 'EXPIRED', dueAt: NOW - HOUR
    }), NOW)).toBe(false)
  })
  it('an expired draft with edits is, until the server keeps them', () => {
    const draft = row({
      status: 'draft', syncStatus: 'pending', serverStatus: 'EXPIRED', dueAt: NOW - HOUR,
      entries: edited(NOW - 2 * HOUR)
    })
    expect(isUndeliveredRound(draft, NOW)).toBe(true)
    expect(isUndeliveredRound({ ...draft, lateProgressKeptMarker: NOW - 2 * HOUR }, NOW)).toBe(false)
    // Edited again after the keep: the newer reading is not on the server.
    expect(isUndeliveredRound({
      ...draft, entries: edited(NOW - HOUR), lateProgressKeptMarker: NOW - 2 * HOUR
    }, NOW)).toBe(true)
  })
  it('a cancelled draft with edits is', () => {
    expect(isUndeliveredRound(row({
      status: 'draft', syncStatus: 'pending', serverStatus: 'CANCELLED', dueAt: NOW + HOUR,
      entries: edited(NOW - HOUR)
    }), NOW)).toBe(true)
  })
  it('counts the round-level answers too, not only assets', () => {
    expect(isUndeliveredRound(row({
      status: 'draft', syncStatus: 'pending', serverStatus: 'EXPIRED', dueAt: NOW - HOUR,
      sheetFormLocallyEditedAt: NOW - 2 * HOUR
    }), NOW)).toBe(true)
  })
})

describe('markers', () => {
  it('latestEditMarker takes the newest of the assets and the round answers', () => {
    expect(latestEditMarker({ entries: edited(5), sheetFormLocallyEditedAt: 9 })).toBe(9)
    expect(latestEditMarker({ entries: edited(5) })).toBe(5)
    expect(latestEditMarker({ entries: [] })).toBeUndefined()
  })
  it('isLateProgressDue: once per state of the markers', () => {
    expect(isLateProgressDue({ entries: edited(5) })).toBe(true)
    expect(isLateProgressDue({ entries: edited(5), lateProgressSentMarker: 5 })).toBe(false)
    expect(isLateProgressDue({ entries: edited(6), lateProgressSentMarker: 5 })).toBe(true)
    expect(isLateProgressDue({ entries: [] })).toBe(false)
  })
})

describe('computeUndeliveredBacklog', () => {
  it('counts and finds the oldest', () => {
    const backlog = computeUndeliveredBacklog([
      row({ localId: 'a', lastSubmitOutcome: 'EXPIRED', completedAt: NOW - 3 * HOUR }),
      row({ localId: 'b', lastSubmitOutcome: 'EXPIRED', completedAt: NOW - 9 * HOUR }),
      row({ localId: 'c', syncStatus: 'synced' })
    ], NOW)
    expect(backlog).toEqual({ count: 2, oldestAt: NOW - 9 * HOUR })
  })
  it('none → zero and no oldest', () => {
    expect(computeUndeliveredBacklog([], NOW)).toEqual({ count: 0, oldestAt: null })
  })
})

describe('reportUndeliveredBacklogIfChanged', () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open()
    await db.logSheets.clear()
    await db.syncMeta.clear()
    reportSyncBacklog.mockReset()
    reportSyncBacklog.mockResolvedValue(undefined)
    await signIn('op1')
  })

  async function signIn(username: string) {
    await db.syncMeta.put({
      key: 'authSession',
      value: {
        accessToken: 'token-' + username,
        tokenType: 'Bearer',
        expiresAt: Date.now() + 86_400_000,
        username,
        fullName: username,
        roles: ['OPERATOR'],
        permissions: []
      }
    })
  }

  it('reports again for a new session even when the count has not changed', async () => {
    // Found live: the server keeps the number on the SESSION's row, so the next operator to sign
    // in on the same tablet must report once, or the panel shows «گزارش نشده» for them.
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW)).toBe(true)
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 1)).toBe(false)

    await signIn('op2')
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 2)).toBe(true)
  })

  it('sends nothing with nobody signed in', async () => {
    await db.syncMeta.delete('authSession')
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW)).toBe(false)
    expect(reportSyncBacklog).not.toHaveBeenCalled()
  })

  it('sends the first time, not again while unchanged, again on a change, and again after an hour', async () => {
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW)).toBe(true)
    expect(reportSyncBacklog).toHaveBeenLastCalledWith({ undeliveredCount: 0, oldestUndeliveredAt: null }, undefined)

    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 1_000)).toBe(false)

    await saveLogSheet(row({ localId: 'late', lastSubmitOutcome: 'EXPIRED', completedAt: NOW - HOUR }))
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 2_000)).toBe(true)
    expect(reportSyncBacklog).toHaveBeenLastCalledWith({ undeliveredCount: 1, oldestUndeliveredAt: NOW - HOUR }, undefined)

    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 3_000)).toBe(false)
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 2_000 + HOUR)).toBe(true)
  })

  it('a failed send is not recorded, so the next pass tries again', async () => {
    reportSyncBacklog.mockRejectedValueOnce(new Error('offline'))
    await expect(reportUndeliveredBacklogIfChanged(undefined, NOW)).rejects.toThrow('offline')
    expect(await reportUndeliveredBacklogIfChanged(undefined, NOW + 1)).toBe(true)
  })
})
