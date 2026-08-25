import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, updateLogSheet } from '@/services/storage'
import {
  dirtyEntriesForProgress,
  getLogSheetsPendingProgress,
  isLogSheetProgressOwnedByUser,
  pushPendingLogSheetProgress
} from '@/services/sync/progressSync'
import type { LogSheet, LogSheetEntryData } from '@/types'

const pushLogSheetProgressBatch = vi.fn()
vi.mock('@/services/api', () => ({
  pushLogSheetProgressBatch: (...args: unknown[]) => pushLogSheetProgressBatch(...args)
}))

/**
 * The progress queue — reporting how far a round has got while it is still being walked.
 *
 * Three properties are what these tests exist to hold, and every one of them was a real defect
 * somewhere else in this app before it was a rule here:
 *
 * 1. **Only what changed is sent.** A progress push runs on a timer; sending the whole sheet
 *    every tick would make the cost proportional to the size of a round times the tick rate
 *    rather than to the work actually done.
 * 2. **Markers are cleared conditionally.** Clearing all of them loses an edit made while the
 *    request was in flight. Clearing none makes the device win those entries on every future
 *    merge, so a supervisor's correction could never reach the tablet — log sheet 85 again.
 * 3. **Nothing here touches `status`, `syncStatus` or `syncError`.** A refused progress report
 *    is not a refused submission: the operator's work is untouched and still deliverable, and
 *    writing the submit queue's fields would make real, undelivered readings look failed.
 */

const NOW = 1_700_000_000_000
const SESSION_USER_ID = '7'

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '10',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '3',
    formData: { temp: 42 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

async function seedSheet(overrides: Partial<LogSheet> = {}): Promise<LogSheet> {
  return saveLogSheet({
    localId: 'sheet-local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: '',
    operatorName: 'اپراتور ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'draft',
    syncStatus: 'pending',
    dueAt: NOW + 3_600_000,
    entries: [entry({ locallyEditedAt: NOW })],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as LogSheet)
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  pushLogSheetProgressBatch.mockReset()
  pushLogSheetProgressBatch.mockResolvedValue([
    { localId: 'sheet-local-1', serverId: 55, outcome: 'SAVED', savedAt: NOW + 1000 }
  ])
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

// ---------------------------------------------------------------- what gets sent

describe('dirtyEntriesForProgress', () => {
  it('sends only entries somebody edited on this device', async () => {
    const sheet = await seedSheet({
      entries: [
        entry({ assetId: '10', locallyEditedAt: NOW }),
        // Received from the server and never touched here. Sending it would be this device
        // echoing the server's own values back at it — pure noise on every tick.
        entry({ assetId: '11', locallyEditedAt: undefined })
      ]
    })

    expect(dirtyEntriesForProgress(sheet).map(e => e.assetId)).toEqual(['10'])
  })

  it('treats a deliberately cleared answer as dirty', async () => {
    // Emptying a field stamps the marker without moving createdAt/updatedAt, exactly so the
    // server's wouldBlankUnseenAnswer can still decide whether to honour the blank. A clear
    // that never leaves the device is a reading the supervisor still sees.
    const sheet = await seedSheet({
      entries: [entry({ formData: {}, locallyEditedAt: NOW })]
    })

    expect(dirtyEntriesForProgress(sheet)).toHaveLength(1)
  })
})

describe('pushPendingLogSheetProgress', () => {
  it('pushes the dirty entries and stamps the server time it came back with', async () => {
    await seedSheet()

    const result = await pushPendingLogSheetProgress()

    expect(result).toEqual({ pushed: 1, refused: 0 })
    expect(pushLogSheetProgressBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          serverId: 55,
          localId: 'sheet-local-1',
          operatorName: 'اپراتور ۱',
          entries: [expect.objectContaining({ assetId: 10, formData: { temp: 42 } })]
        })
      ],
      undefined
    )

    const after = await getLogSheet('sheet-local-1')
    expect(after?.progressSyncStatus).toBe('synced')
    // The server's clock, not the device's — the two differ by exactly the offline gap, and the
    // number the operator wants is when the supervisor last saw their work.
    expect(after?.progressSyncedAt).toBe(NOW + 1000)
  })

  it('does nothing when there is nothing new to report', async () => {
    await seedSheet({ entries: [entry({ locallyEditedAt: undefined })] })

    const result = await pushPendingLogSheetProgress()

    expect(result).toEqual({ pushed: 0, refused: 0 })
    expect(pushLogSheetProgressBatch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------- the marker rule

  it('clears the marker on the entries the server accepted', async () => {
    await seedSheet()

    await pushPendingLogSheetProgress()

    const after = await getLogSheet('sheet-local-1')
    // Once the server holds these values the device has no opinion of its own about them, so a
    // later correction in the browser wins the next merge — which is the point.
    expect(after?.entries[0].locallyEditedAt).toBeUndefined()
    // The values themselves are untouched.
    expect(after?.entries[0].formData).toEqual({ temp: 42 })
  })

  it('keeps the marker on an entry the operator edited while the request was in flight', async () => {
    await seedSheet()
    pushLogSheetProgressBatch.mockImplementation(async () => {
      // The operator saves the same asset again mid-request.
      const current = await getLogSheet('sheet-local-1')
      await updateLogSheet('sheet-local-1', {
        entries: (current?.entries ?? []).map(e => ({
          ...e,
          formData: { temp: 99 },
          locallyEditedAt: NOW + 500
        }))
      })
      return [{ localId: 'sheet-local-1', serverId: 55, outcome: 'SAVED', savedAt: NOW + 1000 }]
    })

    await pushPendingLogSheetProgress()

    const after = await getLogSheet('sheet-local-1')
    // Still dirty: the push covered the old value, not this one. Clearing here would hand the
    // server's older reading back on the next merge.
    expect(after?.entries[0].locallyEditedAt).toBe(NOW + 500)
    expect(after?.entries[0].formData).toEqual({ temp: 99 })
  })

  // ---------------------------------------------------------------- refusals cost nothing

  it('records a refusal without touching the submit queue’s fields', async () => {
    await seedSheet()
    pushLogSheetProgressBatch.mockResolvedValue([
      {
        localId: 'sheet-local-1',
        serverId: 55,
        outcome: 'SUPERSEDED',
        error: 'این لاگ‌شیت دیگر به شما تخصیص ندارد.'
      }
    ])

    const result = await pushPendingLogSheetProgress()

    expect(result).toEqual({ pushed: 0, refused: 1 })
    const after = await getLogSheet('sheet-local-1')
    expect(after?.progressSyncStatus).toBe('failed')
    expect(after?.progressError).toContain('تخصیص')
    // The operator's work is untouched and still theirs to deliver.
    expect(after?.status).toBe('draft')
    expect(after?.syncStatus).toBe('pending')
    expect(after?.syncError).toBeUndefined()
    // Still dirty, so a later reassignment back to them re-reports it.
    expect(after?.entries[0].locallyEditedAt).toBe(NOW)
  })
})

// ---------------------------------------------------------------- who may report

describe('isLogSheetProgressOwnedByUser', () => {
  const base = {
    status: 'draft' as const,
    syncStatus: 'pending' as const,
    serverId: '55',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID
  }

  it('accepts this operator’s own open round', () => {
    expect(isLogSheetProgressOwnedByUser(base, SESSION_USER_ID)).toBe(true)
  })

  it('refuses another operator’s work on a shared tablet', () => {
    // A sign-out removes the session key and nothing else, so a colleague's rows are still here.
    // Pushing them under this token publishes one person's readings under another's name.
    expect(
      isLogSheetProgressOwnedByUser(
        { ...base, localOwnerUserId: '99', assigneeUserId: '99' },
        SESSION_USER_ID
      )
    ).toBe(false)
  })

  it('refuses a row with no owner to prove it by', () => {
    expect(
      isLogSheetProgressOwnedByUser(
        { ...base, localOwnerUserId: undefined, assigneeUserId: undefined },
        SESSION_USER_ID
      )
    ).toBe(false)
  })

  it('refuses a submitted row — that is the submit queue’s business', () => {
    expect(isLogSheetProgressOwnedByUser({ ...base, status: 'submitted' }, SESSION_USER_ID))
      .toBe(false)
  })

  it('refuses a sheet the server has never seen', () => {
    expect(isLogSheetProgressOwnedByUser({ ...base, serverId: undefined }, SESSION_USER_ID))
      .toBe(false)
  })

  it('refuses a cancelled or expired round', () => {
    // Both would be refused on every pass forever. Unlike a completion — judged on the device's
    // completedAt so on-time work delivered late still lands — a progress report is about a
    // round still being walked, and there is no earlier moment it could belong to.
    expect(isLogSheetProgressOwnedByUser({ ...base, serverStatus: 'CANCELLED' }, SESSION_USER_ID))
      .toBe(false)
    expect(isLogSheetProgressOwnedByUser({ ...base, serverStatus: 'EXPIRED' }, SESSION_USER_ID))
      .toBe(false)
  })

  it('refuses when there is no session user id at all', () => {
    expect(isLogSheetProgressOwnedByUser(base, null)).toBe(false)
  })
})

describe('getLogSheetsPendingProgress', () => {
  it('leaves another operator’s dirty draft alone', async () => {
    await seedSheet()
    await saveLogSheet({
      localId: 'sheet-local-2',
      serverId: '56',
      templateId: '3',
      templateName: 'راند دیگر',
      scopeSummary: '',
      assigneeUserId: '99',
      localOwnerUserId: '99',
      status: 'draft',
      syncStatus: 'pending',
      dueAt: NOW + 3_600_000,
      entries: [entry({ locallyEditedAt: NOW })],
      createdAt: NOW,
      updatedAt: NOW
    } as LogSheet)

    const pending = await getLogSheetsPendingProgress()

    expect(pending.map(s => s.localId)).toEqual(['sheet-local-1'])
  })
})
