import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { syncManager } from '@/services/sync'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'

const submitLogSheetsBatch = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...args: unknown[]) => submitLogSheetsBatch(...args),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * A value this device was *sent* must never beat a newer one from the server.
 *
 * <h2>The failure</h2>
 *
 * The merge decided who owned an entry by asking whether the local copy held data. After any
 * sync it always does — the device is holding the server's own readings — so every filled entry
 * on the device counted as local work from then on, whoever had filled it. The consequences, in
 * order:
 *
 * <ol>
 *   <li>a supervisor corrects a reading in the browser;</li>
 *   <li>the tablet syncs, sees its own non-empty copy, and keeps the old value — the correction
 *       is never displayed and the operator has no way to know it exists;</li>
 *   <li>the operator submits, and the stale value is written back over the correction.</li>
 * </ol>
 *
 * <p>Nothing errors, nothing is logged, and the supervisor's edit is simply gone. That is the
 * whole reason `locallyEditedAt` is now the only thing the merge reads: it is written by
 * `applyOperatorEntrySave` and by nothing that receives from the server, so it separates typed
 * from received — which no predicate over `formData` can do.
 *
 * <h2>What these tests are</h2>
 *
 * End-to-end through `applyLogSheetBundle` and the outbound queue, against a real IndexedDB.
 * `mergeLogSheetBundle.test.ts` covers the same rule at the unit level; this file exists because
 * the failure was only ever visible as a sequence — sync, edit elsewhere, sync, submit — and a
 * merge that returns the right object can still be wired up wrongly.
 */

const SESSION_USER_ID = '7'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000

/** Exactly what a sync leaves behind: the server's value, and no marker. */
function receivedFromServer(formData: Record<string, unknown>): LogSheetEntryData {
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

/** The same entry after the operator saved it here — the marker is what the save adds. */
function editedHere(formData: Record<string, unknown>): LogSheetEntryData {
  return applyOperatorEntrySave(receivedFromServer({}), formData, 'manual', NOW)
}

function localSheet(entries: LogSheetEntryData[], overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    entries,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function bundle(formData: Record<string, unknown>, overrides: {
  status?: string
  filledByName?: string | null
  updatedAt?: number
} = {}): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: overrides.status ?? 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: NOW + 3_600_000,
      createdAt: NOW - 60_000,
      updatedAt: NOW
    },
    entries: [
      {
        assetId: 7,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: 2,
        formData,
        filledByName: overrides.filledByName ?? null,
        createdAt: NOW - 10_000,
        updatedAt: overrides.updatedAt ?? NOW - 5_000
      }
    ],
    context: null
  } as LogSheetBundleDto
}

/** The entries the device would actually send for `local-1`. */
function submittedEntries(): Array<Record<string, unknown>> {
  const payload = submitLogSheetsBatch.mock.calls[0][0] as Array<{
    localId: string
    entries: Array<Record<string, unknown>>
  }>
  return payload.find(s => s.localId === 'local-1')!.entries
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.attachments.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  await db.syncMeta.put({
    key: 'authSession',
    value: {
      accessToken: 'token',
      tokenType: 'Bearer',
      expiresAt: NOW + 86_400_000,
      username: 'op',
      fullName: 'اپراتور',
      roles: ['OPERATOR'],
      permissions: []
    }
  })
  submitLogSheetsBatch.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 1_000)
  // `executeSync` returns immediately when the device believes it is offline, and the node test
  // environment has no `navigator.onLine`. Without this the outbound queue never runs and these
  // tests pass by never reaching the code under test.
  vi.stubGlobal('navigator', { onLine: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reported bug
// ─────────────────────────────────────────────────────────────────────────────

describe('a supervisor corrects a reading while the tablet holds the old one', () => {
  it('shows the correction on the next sync', async () => {
    // The device holds `42` because a sync delivered it, not because anybody here typed it.
    await saveLogSheet(localSheet([receivedFromServer({ temp: 42 })]))

    await applyLogSheetBundle(bundle({ temp: 99 }, { filledByName: 'سرپرست' }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 99 })
    // Attribution follows the values, so the operator can see whose reading it is.
    expect(after?.entries[0].filledByName).toBe('سرپرست')
  })

  it('does not send the stale value back on submit', async () => {
    // The second half, and the destructive one: even a device that displayed the correction
    // would still overwrite it if the submit payload were built from the old copy.
    await saveLogSheet(localSheet([receivedFromServer({ temp: 42 })]))
    await applyLogSheetBundle(bundle({ temp: 99 }))

    const synced = await getLogSheet('local-1')
    await saveLogSheet({ ...synced!, status: 'submitted', syncStatus: 'pending' })
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: Number(SERVER_ID), outcome: 'SUBMITTED', error: null }
    ])

    await syncManager.sync()

    expect(submittedEntries()[0].formData).toEqual({ temp: 99 })
  })

  it('takes the correction on an entry that has been synced several times', async () => {
    // The failure needed no unusual state — only a device that had synced at least once, which
    // after the first bundle is every device.
    await saveLogSheet(localSheet([receivedFromServer({ temp: 42 })]))
    await applyLogSheetBundle(bundle({ temp: 42 }))
    await applyLogSheetBundle(bundle({ temp: 42 }))
    await applyLogSheetBundle(bundle({ temp: 42 }))

    await applyLogSheetBundle(bundle({ temp: 99 }))

    expect((await getLogSheet('local-1'))?.entries[0].formData).toEqual({ temp: 99 })
  })

  it('adopts the server timestamps with the value, so the next submit echoes the right base', async () => {
    // `createdAt`/`updatedAt` are the version this device claims to have seen. Displaying the
    // server's value while reporting a base it never held is what made the server refuse
    // legitimate clears on that entry.
    await saveLogSheet(localSheet([receivedFromServer({ temp: 42 })]))

    await applyLogSheetBundle(bundle({ temp: 99 }, { updatedAt: NOW - 1_000 }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].updatedAt).toBe(NOW - 1_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The behaviour that must NOT have been traded away for it
// ─────────────────────────────────────────────────────────────────────────────

describe('work actually done on this device', () => {
  it('survives a bundle carrying a different server value', async () => {
    // The opposite direction, and the more expensive one to get wrong: an operator's unsent
    // reading must not be discarded by a periodic sync.
    await saveLogSheet(localSheet([editedHere({ temp: 7 })]))

    await applyLogSheetBundle(bundle({ temp: 99 }, { filledByName: 'سرپرست' }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 7 })
    expect(after?.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('survives repeated syncs without drifting', async () => {
    await saveLogSheet(localSheet([editedHere({ temp: 7 })]))

    for (let i = 0; i < 5; i++) await applyLogSheetBundle(bundle({ temp: 99 }))

    expect((await getLogSheet('local-1'))?.entries[0].formData).toEqual({ temp: 7 })
  })

  it('is what gets submitted', async () => {
    await saveLogSheet(localSheet([editedHere({ temp: 7 })], {
      status: 'submitted',
      syncStatus: 'pending'
    }))
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: Number(SERVER_ID), outcome: 'SUBMITTED', error: null }
    ])

    await syncManager.sync()

    expect(submittedEntries()[0].formData).toEqual({ temp: 7 })
  })

  it('still counts as work when the operator emptied the entry on purpose', async () => {
    // A clear is an edit. This is the case value presence got wrong in the other direction, and
    // it has to keep working now that the marker is the only criterion.
    await saveLogSheet(localSheet([editedHere({ temp: '' })]))

    await applyLogSheetBundle(bundle({ temp: 42 }))

    expect((await getLogSheet('local-1'))?.entries[0].formData).toEqual({ temp: '' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mixed sheets — the realistic shape
// ─────────────────────────────────────────────────────────────────────────────

describe('one sheet holding both kinds of entry', () => {
  it('keeps the edited one and refreshes the received one', async () => {
    const edited = { ...editedHere({ temp: 7 }), assetId: '7' }
    const received = { ...receivedFromServer({ temp: 42 }), assetId: '8', assetName: 'پمپ ۲' }
    await saveLogSheet(localSheet([edited, received]))

    await applyLogSheetBundle({
      ...bundle({ temp: 99 }),
      entries: [
        { assetId: 7, assetName: 'پمپ ۱', subFunctionCode: 'SF-1', subFunctionTag: 'TAG-1',
          classId: 2, formData: { temp: 99 }, createdAt: NOW - 10_000, updatedAt: NOW - 5_000 },
        { assetId: 8, assetName: 'پمپ ۲', subFunctionCode: 'SF-2', subFunctionTag: 'TAG-2',
          classId: 2, formData: { temp: 88 }, createdAt: NOW - 10_000, updatedAt: NOW - 5_000 }
      ]
    } as LogSheetBundleDto)

    const after = await getLogSheet('local-1')
    expect(after?.entries.map(e => e.formData)).toEqual([{ temp: 7 }, { temp: 88 }])
  })
})
