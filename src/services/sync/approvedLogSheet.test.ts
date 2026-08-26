import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle, mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { isCompletedServerStatus } from '@/types'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'

/**
 * What an approval looks like from the device.
 *
 * <h2>The status</h2>
 *
 * `APPROVED` is a supervisor's review laid on top of a completed round: the round is delivered,
 * the server owns it, and the operator's device must behave exactly as it does for `SUBMITTED`.
 * The danger is not that it behaves differently on purpose — it is that an unhandled status
 * behaves differently by **falling through**. Every branch in `alignLocalWorkflowWithServer`
 * ends in `return null`, meaning "nothing to do", which leaves a stale local draft alive and
 * editable for a round the server has closed. The operator edits it, submits, the server voids
 * it as superseded, and from their side the work vanished with no error anywhere.
 *
 * <h2>What this file covers that the unit tests do not</h2>
 *
 * `logSheetWorkflow.test.ts` pins the decision; this pins the **write**. A merge that returns the
 * right verdict can still be wired up so the row on disk ends up with the wrong status — and
 * `serverStatus` is what the reopen detection, the submit guard and the list chip all read
 * afterwards. Real Dexie, real bundles, the shipping path.
 */

const SESSION_USER_ID = '7'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000

function entry(formData: Record<string, unknown>): LogSheetEntryData {
  return {
    assetId: '7',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '2',
    formData,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000
  }
}

function localSheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'submitted',
    syncStatus: 'synced',
    serverStatus: 'SUBMITTED',
    dueAt: NOW - 3_600_000,
    clientActionId: 'action-1',
    entries: [entry({ temp: 42 })],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function bundle(status: string, overrides: Partial<Record<string, unknown>> = {}): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status,
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: NOW - 3_600_000,
      createdAt: NOW - 60_000,
      updatedAt: NOW,
      ...overrides
    },
    entries: [
      {
        assetId: 7,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: 2,
        formData: { temp: 42 },
        filledByName: null,
        createdAt: NOW - 10_000,
        updatedAt: NOW - 5_000
      }
    ],
    context: null
  } as LogSheetBundleDto
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
})

describe('isCompletedServerStatus', () => {
  /**
   * The client-side twin of the backend's `LogSheetStatus.COMPLETED_STATUSES`. Pinned exactly,
   * so a future status cannot join the set here without somebody deciding it should.
   */
  it('is exactly SUBMITTED and APPROVED', () => {
    expect(isCompletedServerStatus('SUBMITTED')).toBe(true)
    expect(isCompletedServerStatus('APPROVED')).toBe(true)

    expect(isCompletedServerStatus('PENDING')).toBe(false)
    expect(isCompletedServerStatus('ASSIGNED')).toBe(false)
    expect(isCompletedServerStatus('IN_PROGRESS')).toBe(false)
    expect(isCompletedServerStatus('VOIDED')).toBe(false)
    expect(isCompletedServerStatus('EXPIRED')).toBe(false)
    expect(isCompletedServerStatus('CANCELLED')).toBe(false)
    expect(isCompletedServerStatus(null)).toBe(false)
    expect(isCompletedServerStatus(undefined)).toBe(false)
  })
})

describe('a bundle for a round the supervisor has approved', () => {
  /**
   * The write that used to be hard-coded. `applyLogSheetBundle` set `serverStatus: 'SUBMITTED'`
   * on the completed branch regardless of what the server said — which was harmless while
   * SUBMITTED was the only completed status and became a lie the day APPROVED existed. The row
   * would then disagree with the server about a value the list chip and the reopen detection
   * both read.
   */
  it('stores the status the server sent, not a hard-coded SUBMITTED', async () => {
    await saveLogSheet(localSheet({ serverStatus: 'IN_PROGRESS', status: 'draft', syncStatus: 'pending' }))

    await applyLogSheetBundle(bundle('APPROVED'))

    const stored = await getLogSheet('local-1')
    expect(stored?.serverStatus).toBe('APPROVED')
    // ...and it is still a delivered round in every other respect.
    expect(stored?.status).toBe('submitted')
    expect(stored?.syncStatus).toBe('synced')
  })

  it('leaves a SUBMITTED round reading SUBMITTED — the two do not converge', async () => {
    await saveLogSheet(localSheet({ serverStatus: 'IN_PROGRESS', status: 'draft', syncStatus: 'pending' }))

    await applyLogSheetBundle(bundle('SUBMITTED'))

    expect((await getLogSheet('local-1'))?.serverStatus).toBe('SUBMITTED')
  })

  /**
   * A device that has been offline since before the approval. Nothing about the local row may
   * change except the status — the readings on it are the record of what happened at the
   * equipment, and an approval is not a reason to touch them.
   */
  it('does not disturb the readings when the only change is the approval', async () => {
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle('APPROVED'))

    const stored = await getLogSheet('local-1')
    expect(stored?.entries[0].formData).toEqual({ temp: 42 })
    expect(stored?.serverStatus).toBe('APPROVED')
  })
})

describe('an inbox pull that no longer lists an approved round', () => {
  /**
   * An approved sheet is not in anybody's inbox — the server's inbox is ASSIGNED and
   * IN_PROGRESS only. The merge must leave a delivered local row exactly as it is rather than
   * treating the absence as a revocation, which is what `shouldMarkDraftRevokedForMissingInbox`
   * would do to a *draft*.
   */
  it('leaves the delivered local row untouched', async () => {
    await saveLogSheet(localSheet({ serverStatus: 'APPROVED' }))

    await mergeInboxIntoLocalSheets([])

    const stored = await getLogSheet('local-1')
    expect(stored?.serverStatus).toBe('APPROVED')
    expect(stored?.status).toBe('submitted')
    expect(stored?.syncStatus).toBe('synced')
    expect(stored?.syncError).toBeUndefined()
    expect(stored?.entries[0].formData).toEqual({ temp: 42 })
  })
})
