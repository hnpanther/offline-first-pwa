import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { syncManager } from '@/services/sync'
import { ensureLocalLogSheet } from '@/services/sync/logSheetSync'
import type { LogSheet } from '@/types'

const submitLogSheetsBatch = vi.fn()
const submitNfcFaultReportsBatch = vi.fn()
const fetchLogSheetBundle = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...a: unknown[]) => submitLogSheetsBatch(...a),
  submitNfcFaultReportsBatch: (...a: unknown[]) => submitNfcFaultReportsBatch(...a),
  fetchLogSheetBundle: (...a: unknown[]) => fetchLogSheetBundle(...a),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * Offline is the normal state, not the error state.
 *
 * <p>This app exists because a plant round happens where there is no signal. Every rule below is
 * therefore about what must **not** happen when the network is absent: no request, no data loss,
 * no queue that quietly empties itself, and no state that only heals if a sync happened to
 * succeed. The failure these guard against is the expensive one — a shift's readings gone with
 * nothing to show for them — and it is invisible until somebody asks for a report weeks later.
 *
 * <p>The offline→online transition is included deliberately: a queue that survives being offline
 * but never drains is the same lost shift, just later.
 */

const SESSION_USER_ID = '7'
const NOW = 1_700_000_000_000

function pendingSheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'submitted',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    completedAt: NOW - 1_000,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 42 },
        createdAt: NOW - 10_000,
        updatedAt: NOW - 5_000
      }
    ],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function goOffline() {
  vi.stubGlobal('navigator', { onLine: false })
}

function goOnline() {
  vi.stubGlobal('navigator', { onLine: true })
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.attachments.clear()
  await db.nfcFaultReports.clear()
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
  submitNfcFaultReportsBatch.mockReset()
  fetchLogSheetBundle.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 1_000)
  goOnline()
})

describe('while the device is offline', () => {
  it('makes no request at all', async () => {
    // Not "the request fails and is handled" — no request is attempted. A tablet in a plant
    // basement must not spend its battery on TCP connects that cannot complete.
    await saveLogSheet(pendingSheet())
    goOffline()

    await syncManager.sync()

    expect(submitLogSheetsBatch).not.toHaveBeenCalled()
    expect(submitNfcFaultReportsBatch).not.toHaveBeenCalled()
  })

  it('leaves completed work queued exactly as it was', async () => {
    await saveLogSheet(pendingSheet())
    goOffline()

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('pending')
    expect(after?.syncError).toBeUndefined()
    // The readings are untouched: being offline is not an outcome the server reported.
    expect(after?.entries[0].formData).toEqual({ temp: 42 })
  })

  it('does not mark anything failed', async () => {
    // `failed` means "the server answered and said no". Absence of a server is not a refusal,
    // and showing it as one sends an operator chasing a problem that does not exist.
    await saveLogSheet(pendingSheet())
    goOffline()

    await syncManager.sync()

    expect((await getLogSheet('local-1'))?.syncStatus).not.toBe('failed')
  })

  it('opens a sheet from the local cache when the bundle cannot be fetched', async () => {
    // The fill page asks for a fresh bundle when it believes it is online. A failure there must
    // fall through to what the device already holds, not blank the screen.
    await saveLogSheet(pendingSheet({ status: 'draft', syncStatus: 'pending' }))
    fetchLogSheetBundle.mockRejectedValue(new Error('Failed to fetch'))

    const sheet = await ensureLocalLogSheet(
      { id: 55, templateId: 3, templateName: 'راند روزانه' } as never,
      { refreshBundleOnline: true }
    )

    expect(sheet.localId).toBe('local-1')
    expect(sheet.entries[0].formData).toEqual({ temp: 42 })
  })
})

describe('when the network fails mid-sync', () => {
  it('keeps the work pending rather than losing or failing it', async () => {
    // A dropped link between "request sent" and "response read" is the commonest thing that
    // happens on plant Wi-Fi. The queue has to survive it untouched, because the alternative is
    // deciding an outcome the server never reported.
    await saveLogSheet(pendingSheet())
    submitLogSheetsBatch.mockRejectedValue(new Error('Failed to fetch'))

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('pending')
    expect(after?.entries[0].formData).toEqual({ temp: 42 })
  })

  it('reports the failure as transient, so the UI does not cry wolf', async () => {
    await saveLogSheet(pendingSheet())
    submitLogSheetsBatch.mockRejectedValue(new Error('Failed to fetch'))
    const events: Array<{ type: string; transient?: boolean }> = []
    const unsubscribe = syncManager.subscribe(e => events.push(e))

    await syncManager.sync()
    unsubscribe()

    const errors = events.filter(e => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].transient).toBe(true)
  })
})

describe('coming back online', () => {
  it('drains work queued while there was no network', async () => {
    // The whole point of the queue. Offline, then online, and the round reaches the server
    // without the operator doing anything.
    await saveLogSheet(pendingSheet())

    goOffline()
    await syncManager.sync()
    expect((await getLogSheet('local-1'))?.syncStatus).toBe('pending')

    goOnline()
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: 55, outcome: 'SUBMITTED', error: null }
    ])
    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('synced')
    expect(after?.serverStatus).toBe('SUBMITTED')
  })

  it('retries after a transient failure instead of parking the sheet', async () => {
    await saveLogSheet(pendingSheet())

    submitLogSheetsBatch.mockRejectedValueOnce(new Error('Failed to fetch'))
    await syncManager.sync()
    expect((await getLogSheet('local-1'))?.syncStatus).toBe('pending')

    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: 55, outcome: 'SUBMITTED', error: null }
    ])
    await syncManager.sync()

    expect((await getLogSheet('local-1'))?.syncStatus).toBe('synced')
  })

  it('still parks a sheet the server actually refused', async () => {
    // The other half of the rule: a real refusal must NOT be retried forever. Only the absence
    // of an answer is transient.
    await saveLogSheet(pendingSheet())
    submitLogSheetsBatch.mockResolvedValue([
      { localId: 'local-1', serverId: 55, outcome: 'EXPIRED', error: null }
    ])

    await syncManager.sync()

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('failed')
    expect(after?.serverStatus).toBe('EXPIRED')
  })
})
