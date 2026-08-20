import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, resetLogSheetToOpenDraft, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { syncManager } from '@/services/sync'
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
 * `locallyEditedAt` — the record that this device has an opinion about an asset.
 *
 * <h2>Why a marker exists at all</h2>
 *
 * The merge has to answer one question per entry: does this device hold work the server should
 * not overwrite? Two attempts to infer that answer from `formData` alone have both lost real
 * data in production:
 *
 * - **key presence** counted a blank the web fill form had written as work, so a supervisor's
 *   readings became invisible and were then destroyed by the next submit (log sheet 85);
 * - **value presence** counts a *deliberate clear* as no work, so the next sync restored the
 *   value the operator had just removed.
 *
 * Neither is a bug in the predicate — they are both the wrong question. The opinion is now
 * recorded when it is formed, by the save.
 *
 * <h2>The danger the marker itself carries</h2>
 *
 * A marker that outlives its submission makes the device win that entry **forever**, which is
 * log sheet 85 again by another route. Two independent mechanisms prevent that, and the tests
 * below exercise each on its own so that neither can quietly stop working behind the other:
 *
 * 1. markers are cleared when the server accepts the work, and whenever a row is reset;
 * 2. `applyLogSheetBundle` ignores markers on a row that is already `submitted` + `synced`.
 */

const SESSION_USER_ID = '7'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '7',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '2',
    formData: { temp: 42 },
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    ...overrides
  }
}

/** An entry the operator deliberately emptied: blank keys, base timestamps, marker set. */
function clearedEntry(): LogSheetEntryData {
  return entry({ formData: { temp: '' }, locallyEditedAt: NOW })
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
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    entries: [clearedEntry()],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

/** The server still holds the value the operator has just removed on the device. */
function bundle(overrides: {
  status?: string
  formData?: Record<string, unknown>
  assigneeUserId?: number | null
} = {}): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: overrides.status ?? 'IN_PROGRESS',
      assigneeUserId:
        overrides.assigneeUserId === undefined
          ? Number(SESSION_USER_ID)
          : overrides.assigneeUserId,
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
        formData: overrides.formData ?? { temp: 42 },
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
  // environment has no `navigator.onLine`. Declaring it here is what lets the outbound queue run
  // at all — without it these tests pass by never reaching the code under test.
  vi.stubGlobal('navigator', { onLine: true })
})

describe('an unsent draft', () => {
  it('keeps the operator’s clear through a periodic bundle refresh', async () => {
    // The reported failure: the operator empties the last field, a sync tick fires before they
    // submit, and the old server value is written back over their deletion.
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle())

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: '' })
    expect(after?.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('keeps the base timestamps with the clear', async () => {
    // Echoed back on submit and read by the server as "the version this device last saw". A
    // clear whose base matches is applied; one that has drifted is refused as stale.
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle())

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].createdAt).toBe(NOW - 10_000)
    expect(after?.entries[0].updatedAt).toBe(NOW - 5_000)
  })

  it('still takes the server’s value for an entry this operator never touched', async () => {
    // No marker: the entry the supervisor filled in the browser must appear. This is the case
    // the marker must never be allowed to swallow.
    await saveLogSheet(localSheet({ entries: [entry({ formData: {} })] }))

    await applyLogSheetBundle(bundle({ formData: { temp: 99 } }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 99 })
  })

  it('gives up the clear when the sheet is no longer this operator’s work', async () => {
    // Reassigned away: `shouldPreserveLocalFormData` is false, and a local marker cannot
    // override that. What is on the server is what this device shows.
    await saveLogSheet(localSheet({ localOwnerUserId: '99', assigneeUserId: '99' }))

    await applyLogSheetBundle(bundle({ assigneeUserId: 99 }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 42 })
    expect(after?.entries[0].locallyEditedAt).toBeUndefined()
  })
})

describe('an unsent completion', () => {
  it('is left entirely alone by a bundle refresh, markers included', async () => {
    // Unchanged rule, re-pinned here because the marker must not become a reason to touch a
    // row that only the batch-submit outcome may resolve.
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'pending' }))

    await applyLogSheetBundle(bundle({ status: 'SUBMITTED', formData: { temp: 42 } }))

    const after = await getLogSheet('local-1')
    expect(after?.status).toBe('submitted')
    expect(after?.syncStatus).toBe('pending')
    expect(after?.entries[0].formData).toEqual({ temp: '' })
    expect(after?.entries[0].locallyEditedAt).toBe(NOW)
  })
})

describe('once the server has accepted the work', () => {
  it('the marker is cleared, so nothing is left to win a later merge', async () => {
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'pending' }))
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: Number(SERVER_ID), outcome: 'SUBMITTED', error: null }
    ])

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('synced')
    expect(after?.entries[0].locallyEditedAt).toBeUndefined()
    // The clear itself is kept — it is the server's now, not something to undo.
    expect(after?.entries[0].formData).toEqual({ temp: '' })
  })

  it('a duplicate outcome clears it too', async () => {
    // DUPLICATE means the server already holds this work. Same conclusion as SUBMITTED.
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'pending' }))
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: Number(SERVER_ID), outcome: 'DUPLICATE', error: null }
    ])

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('a rejected submission keeps the marker, because the work was never delivered', async () => {
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'pending' }))
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: Number(SERVER_ID), outcome: 'EXPIRED', error: null }
    ])

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('failed')
    expect(after?.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('a supervisor’s later edit lands even if a marker somehow survived', async () => {
    // The second lock. `submitted` + `synced` means everything this row holds came from the
    // server, so a marker still standing describes an opinion that no longer exists. Honouring
    // it here is exactly how log sheet 85 happened, so the guard does not depend on the clear
    // above having run.
    await saveLogSheet(localSheet({
      status: 'submitted',
      syncStatus: 'synced',
      serverStatus: 'SUBMITTED'
    }))

    await applyLogSheetBundle(bundle({ status: 'IN_PROGRESS', formData: { temp: 99 } }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 99 })
    expect(after?.entries[0].locallyEditedAt).toBeUndefined()
  })
})

describe('reopen and continue', () => {
  it('does not resurrect a delivered opinion when the row becomes a draft again', async () => {
    // The path that makes this dangerous: `resetLogSheetToOpenDraft` is called WITHOUT
    // `clearEntryFormData`, on purpose — the operator is carrying on with their own readings.
    // But it turns a delivered row back into a draft, which re-arms the marker gate. Any marker
    // left standing would then beat the server for the rest of the sheet's life, hiding
    // whatever the supervisor changed while it was reopened.
    await saveLogSheet(localSheet({
      status: 'submitted',
      syncStatus: 'synced',
      serverStatus: 'SUBMITTED',
      entries: [clearedEntry()]
    }))

    await resetLogSheetToOpenDraft('local-1')
    const reset = await getLogSheet('local-1')
    expect(reset?.status).toBe('draft')
    expect(reset?.entries[0].locallyEditedAt).toBeUndefined()
    // The readings themselves survive the reset — that is what this path is for.
    expect(reset?.entries[0].formData).toEqual({ temp: '' })

    await applyLogSheetBundle(bundle({ status: 'IN_PROGRESS', formData: { temp: 99 } }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: 99 })
  })

  it('a clear made after the reopen is kept again', async () => {
    // And the marker still does its job on the new editing session.
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'synced' }))
    await resetLogSheetToOpenDraft('local-1')

    const sheet = await getLogSheet('local-1')
    await db.logSheets.update(sheet!.id!, {
      entries: [{ ...sheet!.entries[0], formData: { temp: '' }, locallyEditedAt: NOW + 500 }]
    })

    await applyLogSheetBundle(bundle({ status: 'IN_PROGRESS', formData: { temp: 99 } }))

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: '' })
  })
})
