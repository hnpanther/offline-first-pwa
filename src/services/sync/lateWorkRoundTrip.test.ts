import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, updateLogSheet } from '@/services/storage'
import { syncManager } from '@/services/sync'
import { mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import { computeUndeliveredBacklog } from '@/services/sync/undelivered'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet } from '@/types'

const submitLogSheetsBatch = vi.fn()
const pushLogSheetProgressBatch = vi.fn()
const reportSyncBacklog = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...a: unknown[]) => submitLogSheetsBatch(...a),
  pushLogSheetProgressBatch: (...a: unknown[]) => pushLogSheetProgressBatch(...a),
  reportSyncBacklog: (...a: unknown[]) => reportSyncBacklog(...a),
  submitNfcFaultReportsBatch: vi.fn(),
  fetchLogSheetBundle: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * Issues P-01, P-02 and P-03 end to end on the device, against the answers backend V25 gives —
 * through the real SyncManager, progress lane and inbox merge, on a real (fake) IndexedDB.
 *
 * The rule: **work that reaches the server late is sent, and the device records what the server
 * did with it.** Nothing is marked failed before the server has answered; nothing kept is
 * counted as lost; nothing refused is counted as delivered; and every lifecycle a supervisor can
 * drive afterwards — extend, reassign, reopen — still works on the rows this leaves behind.
 */

const SESSION_USER_ID = '7'
const SERVER_ID = '55'
const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DUE = NOW - 2 * HOUR // the deadline has passed
const READINGS = { temp: 42 }

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
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
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: DUE,
    clientActionId: 'action-1',
    completedAt: DUE + HOUR, // finished after the deadline
    submittedAt: DUE + HOUR,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { ...READINGS },
        locallyEditedAt: DUE + HOUR - 60_000,
        createdAt: DUE - HOUR,
        updatedAt: DUE + HOUR - 60_000
      }
    ],
    createdAt: DUE - 2 * HOUR,
    updatedAt: DUE + HOUR,
    ...overrides
  } as LogSheet
}

/** An expired draft: walked partly, never completed, deadline passed. */
function expiredDraft(overrides: Partial<LogSheet> = {}): LogSheet {
  return sheet({
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'EXPIRED',
    completedAt: undefined,
    submittedAt: undefined,
    clientActionId: undefined,
    ...overrides
  })
}

function inboxBundle(over: Partial<LogSheetBundleDto['sheet']> = {}): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: NOW + 4 * HOUR,
      createdAt: DUE - 2 * HOUR,
      updatedAt: NOW,
      ...over
    },
    // What the server holds for this round: none of the late readings, which were kept, not
    // applied. The merge must not let these blank the device's values.
    entries: [
      { assetId: 7, assetName: 'پمپ ۱', subFunctionCode: 'SF-1', subFunctionTag: 'TAG-1', classId: 2, formData: {} }
    ],
    context: null
  } as unknown as LogSheetBundleDto
}

async function row(): Promise<LogSheet> {
  const found = await getLogSheet('local-1')
  if (!found) throw new Error('the local row disappeared — that is data loss')
  return found
}

function submitAnswers(...answers: Array<Record<string, unknown>>) {
  submitLogSheetsBatch.mockImplementation(async (items: Array<{ localId: string; serverId: number }>) =>
    items.map((item, i) => ({ localId: item.localId, serverId: item.serverId, ...answers[Math.min(i, answers.length - 1)] }))
  )
}

function progressAnswer(answer: Record<string, unknown>) {
  pushLogSheetProgressBatch.mockImplementation(async (items: Array<{ localId: string; serverId: number }>) =>
    items.map(item => ({ localId: item.localId, serverId: item.serverId, ...answer }))
  )
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
      permissions: ['POST:/api/log-sheets/batch', 'POST:/api/log-sheets/progress']
    }
  })
  submitLogSheetsBatch.mockReset()
  pushLogSheetProgressBatch.mockReset()
  reportSyncBacklog.mockReset()
  reportSyncBacklog.mockResolvedValue(undefined)
  pushLogSheetProgressBatch.mockResolvedValue([])
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubGlobal('navigator', { onLine: true })
})

// =============================================================================================
// P-02 — a round completed after its deadline is sent, once, and the answer is recorded
// =============================================================================================

describe('a completion finished after its deadline (P-02)', () => {
  it('is sent to the server instead of being failed locally', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته', kept: true })

    await syncManager.sync()

    expect(submitLogSheetsBatch).toHaveBeenCalledOnce()
    const sent = submitLogSheetsBatch.mock.calls[0][0][0]
    expect(sent.completedAt).toBe(DUE + HOUR)
    expect(sent.entries[0].formData).toEqual(READINGS)
  })

  it('records that the server kept it, stays failed, and keeps the readings', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته', kept: true })

    await syncManager.sync()

    const after = await row()
    expect(after.syncStatus).toBe('failed')
    expect(after.lastSubmitOutcome).toBe('EXPIRED')
    expect(after.serverKeptAt).toBe(NOW)
    expect(after.entries[0].formData).toEqual(READINGS)
    // Kept on the server is not undelivered.
    expect(computeUndeliveredBacklog([after], NOW).count).toBe(0)
  })

  it('is sent exactly once — the next pass does not resend it', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته', kept: true })

    await syncManager.sync()
    await syncManager.sync()

    expect(submitLogSheetsBatch).toHaveBeenCalledOnce()
  })

  it('against a server too old to keep it: failed, not kept, and counted as undelivered', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته' })

    await syncManager.sync()

    const after = await row()
    expect(after.syncStatus).toBe('failed')
    expect(after.serverKeptAt).toBeUndefined()
    expect(after.entries[0].formData).toEqual(READINGS)
    expect(computeUndeliveredBacklog([after], NOW)).toEqual({ count: 1, oldestAt: DUE + HOUR })
  })

  it('is not marked failed while the device is offline — only the server may refuse it', async () => {
    await saveLogSheet(sheet())
    vi.stubGlobal('navigator', { onLine: false })

    await syncManager.sync()

    const after = await row()
    expect(after.syncStatus).toBe('pending')
    expect(submitLogSheetsBatch).not.toHaveBeenCalled()
  })

  it('an inbox merge does not fail it before it is sent either', async () => {
    await saveLogSheet(sheet())

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: DUE })])

    expect((await row()).syncStatus).toBe('pending')
  })

  it('after the supervisor extends the deadline it is re-queued with a new key and delivered', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته', kept: true })
    await syncManager.sync()

    // The supervisor extends: the round is open again in this operator's inbox.
    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'IN_PROGRESS', dueAt: NOW + 4 * HOUR })])
    const requeued = await row()
    expect(requeued.syncStatus).toBe('pending')
    expect(requeued.clientActionId).not.toBe('action-1')

    submitAnswers({ outcome: 'SUBMITTED' })
    await syncManager.sync()

    const delivered = await row()
    expect(delivered.syncStatus).toBe('synced')
    expect(submitLogSheetsBatch.mock.calls[1][0][0].clientActionId).toBe(requeued.clientActionId)
    expect(delivered.entries[0].formData).toEqual(READINGS)
  })
})

describe('one idempotency key per completion (P-07)', () => {
  it('a queued row with no key is given one, stored, and every retry carries the same one', async () => {
    await saveLogSheet(sheet({ clientActionId: undefined, dueAt: NOW + HOUR, completedAt: NOW - 60_000 }))
    // The first response is lost on a weak link.
    submitLogSheetsBatch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await syncManager.sync()
    submitAnswers({ outcome: 'SUBMITTED' })
    await syncManager.sync()

    const first = submitLogSheetsBatch.mock.calls[0][0][0].clientActionId
    const retry = submitLogSheetsBatch.mock.calls[1][0][0].clientActionId
    expect(first).toBeTruthy()
    expect(retry).toBe(first)
    expect((await row()).clientActionId).toBe(first)
  })
})

// =============================================================================================
// P-03 — a refused replay is never read as a delivery
// =============================================================================================

describe('a refused submission, including a replay of one (P-03)', () => {
  it('SUPERSEDED with kept stays failed — the server holds it for review, it is not delivered', async () => {
    await saveLogSheet(sheet({ dueAt: NOW + HOUR, completedAt: NOW - 60_000 }))
    submitAnswers({ outcome: 'SUPERSEDED', error: 'دیگری تکمیل کرد', kept: true })

    await syncManager.sync()

    const after = await row()
    expect(after.syncStatus).toBe('failed')
    expect(after.serverKeptAt).toBe(NOW)
    expect(after.entries[0].locallyEditedAt).toBeDefined()
  })

  it('a genuine DUPLICATE is still a delivery', async () => {
    await saveLogSheet(sheet({ dueAt: NOW + HOUR, completedAt: NOW - 60_000 }))
    submitAnswers({ outcome: 'DUPLICATE' })

    await syncManager.sync()

    expect((await row()).syncStatus).toBe('synced')
  })
})

// =============================================================================================
// P-01 — an expired draft's readings are sent as late progress and kept
// =============================================================================================

describe('an expired draft with readings (P-01)', () => {
  it('pushes its readings once, and records that the server kept them', async () => {
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'EXPIRED', error: 'مهلت گذشته', kept: true, savedAt: NOW })

    await syncManager.sync()

    expect(pushLogSheetProgressBatch).toHaveBeenCalledOnce()
    expect(pushLogSheetProgressBatch.mock.calls[0][0][0].entries[0].formData).toEqual(READINGS)
    const after = await row()
    expect(after.lateProgressKeptAt).toBe(NOW)
    expect(after.lateProgressKeptMarker).toBe(DUE + HOUR - 60_000)
    expect(after.progressSyncStatus).toBe('synced')
    // Kept is not applied: the markers stay, so the device still wins a later merge.
    expect(after.entries[0].locallyEditedAt).toBe(DUE + HOUR - 60_000)
    // Neither the draft nor its state changed — it is still the operator's expired draft.
    expect(after.status).toBe('draft')
    expect(after.syncStatus).toBe('pending')
    expect(computeUndeliveredBacklog([after], NOW).count).toBe(0)
  })

  it('is not pushed again until something newer is edited', async () => {
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'EXPIRED', kept: true, savedAt: NOW })

    await syncManager.sync()
    await syncManager.sync()
    expect(pushLogSheetProgressBatch).toHaveBeenCalledOnce()

    const current = await row()
    await updateLogSheet('local-1', {
      entries: [{ ...current.entries[0], formData: { temp: 43 }, locallyEditedAt: NOW }]
    })
    await syncManager.sync()
    expect(pushLogSheetProgressBatch).toHaveBeenCalledTimes(2)
  })

  it('against an older server: sent once, refused, and counted as undelivered', async () => {
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'EXPIRED', error: 'مهلت گذشته' })

    await syncManager.sync()
    await syncManager.sync()

    expect(pushLogSheetProgressBatch).toHaveBeenCalledOnce()
    const after = await row()
    expect(after.lateProgressKeptAt).toBeUndefined()
    expect(after.progressSyncStatus).toBe('failed')
    expect(after.entries[0].formData).toEqual(READINGS)
    expect(computeUndeliveredBacklog([after], NOW).count).toBe(1)
  })

  it('a refusal other than EXPIRED (handed to somebody else first) is also sent only once', async () => {
    // Before its first late push the round was reassigned: the server answers SUPERSEDED, not
    // EXPIRED. It must not be re-sent every 30 seconds for ever.
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'SUPERSEDED', error: 'دیگر به شما تخصیص ندارد' })

    await syncManager.sync()
    await syncManager.sync()
    await syncManager.sync()

    expect(pushLogSheetProgressBatch).toHaveBeenCalledOnce()
    const after = await row()
    expect(after.lateProgressSentMarker).toBe(DUE + HOUR - 60_000)
    expect(after.lateProgressKeptAt).toBeUndefined()
    expect(after.entries[0].formData).toEqual(READINGS)
    // Nothing kept it: still counted, so the supervisor sees the tablet holds it.
    expect(computeUndeliveredBacklog([after], NOW).count).toBe(1)
  })

  it('after an extension the merge keeps the device readings and they then go as ordinary progress', async () => {
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'EXPIRED', kept: true, savedAt: NOW })
    await syncManager.sync()

    // Extended: the bundle comes back open, with the server's (blank) values for the asset.
    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'IN_PROGRESS', dueAt: NOW + 4 * HOUR })])
    const reopened = await row()
    expect(reopened.entries[0].formData).toEqual(READINGS)
    expect(reopened.lateProgressSentMarker).toBeUndefined()

    progressAnswer({ outcome: 'SAVED', savedAt: NOW })
    await syncManager.sync()

    expect(pushLogSheetProgressBatch).toHaveBeenCalledTimes(2)
    expect(pushLogSheetProgressBatch.mock.calls[1][0][0].entries[0].formData).toEqual(READINGS)
    const applied = await row()
    expect(applied.entries[0].locallyEditedAt).toBeUndefined()
    expect(applied.entries[0].formData).toEqual(READINGS)
  })

  it('handed to another operator after expiry: the row and its readings stay, and it counts', async () => {
    await saveLogSheet(expiredDraft())
    progressAnswer({ outcome: 'EXPIRED', error: 'مهلت گذشته' })
    await syncManager.sync()

    // The supervisor gives the round to somebody else: it leaves this operator's inbox. An
    // expired draft is not revoked by that (expired rounds leave the inbox anyway); what matters
    // is that nothing deletes it and the count says it holds readings the server never received.
    await mergeInboxIntoLocalSheets([])

    const after = await row()
    expect(after.status).toBe('draft')
    expect(after.entries[0].formData).toEqual(READINGS)
    expect(computeUndeliveredBacklog([after], NOW).count).toBe(1)
  })
})

// =============================================================================================
// The panel hears about it
// =============================================================================================

describe('the backlog report', () => {
  it('reports the undelivered count after a pass, and not again while it is unchanged', async () => {
    await saveLogSheet(sheet())
    submitAnswers({ outcome: 'EXPIRED', error: 'مهلت گذشته' })

    await syncManager.sync()
    expect(reportSyncBacklog).toHaveBeenCalledOnce()
    expect(reportSyncBacklog.mock.calls[0][0]).toEqual({
      undeliveredCount: 1,
      oldestUndeliveredAt: DUE + HOUR
    })

    await syncManager.sync()
    expect(reportSyncBacklog).toHaveBeenCalledOnce()
  })

  it('a report the server refuses never fails the pass', async () => {
    await saveLogSheet(sheet({ dueAt: NOW + HOUR, completedAt: NOW - 1 }))
    submitAnswers({ outcome: 'SUBMITTED' })
    reportSyncBacklog.mockRejectedValue(new Error('404'))

    await syncManager.sync()

    expect((await row()).syncStatus).toBe('synced')
  })
})
