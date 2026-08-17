import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { expireStaleLocalDrafts, mergeInboxIntoLocalSheets } from '@/services/sync/logSheetSync'
import {
  canSubmitLogSheet,
  completedWithinDeadline,
  isLogSheetExpiredForSync,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet } from '@/types'

/**
 * What an inbox pull does to work that was done offline.
 *
 * `mergeInboxIntoLocalSheets` is where every server-side lifecycle decision lands on the
 * device: a deadline that passed, a supervisor who extended it, a round that was cancelled
 * mid-shift, a completion the server rejected as late. It runs on every sync pass, against
 * rows that may hold hours of work nobody else has a copy of, so the rule it has to obey is
 * narrow and absolute: **update what the server owns, never destroy what the operator did.**
 *
 * The server half of each of these is covered on the backend (`extendReopensExpiredSheet`,
 * `extendReopensCancelledSheetWithAssignee`, `completedBeforeDueAcceptedEvenWhenServerMarked-
 * Expired`, `lateCompletionAfterExpiryStaysExpired`, `submitReturnsCancelledWhenSheetWas-
 * CancelledAndPreservesTheOperatorsData`). These are the device half — the translation of
 * those answers onto the local row, which had no tests at all.
 */

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const PAST = NOW - HOUR
const FUTURE = NOW + HOUR
const SESSION_USER_ID = '7'
const SERVER_ID = '55'

const READINGS = { temp: 42, note: 'صدای غیرعادی' }

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
    dueAt: FUTURE,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { ...READINGS },
        filledVia: 'nfc',
        createdAt: PAST,
        updatedAt: PAST
      }
    ],
    createdAt: PAST - HOUR,
    updatedAt: PAST,
    ...overrides
  } as LogSheet
}

/** What the server sends back for that sheet in the operator's assigned inbox. */
function inboxBundle(sheet: Partial<LogSheetBundleDto['sheet']> = {}): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: FUTURE,
      createdAt: PAST - HOUR,
      updatedAt: PAST,
      ...sheet
    },
    entries: [
      {
        assetId: 7,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: 2,
        // The server has never seen this round's readings — they were entered offline.
        formData: {}
      }
    ],
    context: null
  } as unknown as LogSheetBundleDto
}

async function readSheet(): Promise<LogSheet> {
  const sheet = await getLogSheet('local-1')
  if (!sheet) throw new Error('local sheet disappeared')
  return sheet
}

/** The readings the operator entered, as stored right now. */
async function storedReadings(): Promise<unknown> {
  return (await readSheet()).entries[0]?.formData
}

beforeEach(async () => {
  // Only `Date` is faked. Faking timers wholesale deadlocks fake-indexeddb, which needs its
  // own callbacks to run.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('a deadline that passes while the tablet is offline', () => {
  it('marks the draft expired locally, so the operator learns it before a round trip', async () => {
    await saveLogSheet(localSheet({ dueAt: PAST }))

    await expireStaleLocalDrafts(NOW)

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('EXPIRED')
    expect(sheet.syncError).toBe(SYNC_OUTCOME_MESSAGES.EXPIRED)
  })

  it('keeps the readings — an expired round is still evidence of work done', async () => {
    await saveLogSheet(localSheet({ dueAt: PAST }))

    await expireStaleLocalDrafts(NOW)

    expect(await storedReadings()).toEqual(READINGS)
  })

  it('leaves a draft that is still inside its deadline alone', async () => {
    await saveLogSheet(localSheet({ dueAt: FUTURE }))

    await expireStaleLocalDrafts(NOW)

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('IN_PROGRESS')
    expect(sheet.syncError).toBeUndefined()
  })

  it('does not touch a sheet that has never been to the server', async () => {
    // No `serverId` means the sheet was raised on this device and the server cannot have an
    // opinion about its deadline yet.
    await saveLogSheet(localSheet({ serverId: undefined, dueAt: PAST }))

    await expireStaleLocalDrafts(NOW)

    expect((await readSheet()).serverStatus).toBe('IN_PROGRESS')
  })
})

describe('the supervisor extends a deadline that had already passed', () => {
  it('hands the round back with the new deadline and no failure banner', async () => {
    await saveLogSheet(
      localSheet({
        dueAt: PAST,
        serverStatus: 'EXPIRED',
        syncError: SYNC_OUTCOME_MESSAGES.EXPIRED
      })
    )

    // `POST /log-sheets/{id}/extend` un-expires the sheet; it comes back in the inbox.
    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'IN_PROGRESS', dueAt: FUTURE })])

    const sheet = await readSheet()
    expect(sheet.dueAt).toBe(FUTURE)
    expect(sheet.serverStatus).toBe('IN_PROGRESS')
    expect(sheet.syncError).toBeUndefined()
  })

  it('keeps everything the operator had already entered', async () => {
    // The whole point of extending rather than raising a new round.
    await saveLogSheet(
      localSheet({ dueAt: PAST, serverStatus: 'EXPIRED', syncError: SYNC_OUTCOME_MESSAGES.EXPIRED })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ dueAt: FUTURE })])

    expect(await storedReadings()).toEqual(READINGS)
  })

  it('leaves the sheet genuinely submittable again, not merely tidy on screen', async () => {
    await saveLogSheet(
      localSheet({ dueAt: PAST, serverStatus: 'EXPIRED', syncError: SYNC_OUTCOME_MESSAGES.EXPIRED })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ dueAt: FUTURE })])

    expect(canSubmitLogSheet(await readSheet(), NOW)).toEqual({ ok: true })
  })

  it('does not treat a still-expired sheet as extended', async () => {
    // Same sheet, same inbox, but the deadline the server reports is still in the past.
    await saveLogSheet(
      localSheet({ dueAt: PAST, serverStatus: 'EXPIRED', syncError: SYNC_OUTCOME_MESSAGES.EXPIRED })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: PAST })])

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('EXPIRED')
    expect(canSubmitLogSheet(sheet, NOW).ok).toBe(false)
  })

  it('is not what puts a rejected completion back in the queue — the completion time is', async () => {
    // A sheet the server calls EXPIRED while reporting a deadline in the future is not an
    // extension: `extended` requires both. It is still re-queued, but through the branch below
    // and for a different reason — the device's own record says the work was finished before
    // the deadline, and the server accepts exactly that (backend
    // `completedBeforeDueAcceptedEvenWhenServerMarkedExpired`), so the retry is one that
    // succeeds rather than a loop.
    await saveLogSheet(
      localSheet({
        status: 'submitted',
        syncStatus: 'failed',
        serverStatus: 'EXPIRED',
        syncError: SYNC_OUTCOME_MESSAGES.EXPIRED,
        dueAt: FUTURE,
        completedAt: NOW,
        submittedAt: NOW,
        clientActionId: 'rejected-action-id'
      })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: FUTURE })])

    const sheet = await readSheet()
    expect(sheet.syncStatus).toBe('pending')
    expect(sheet.serverStatus).toBe('EXPIRED')
    expect(sheet.clientActionId).not.toBe('rejected-action-id')
  })
})

describe('a round cancelled by the supervisor while the operator is filling it offline', () => {
  it('blocks the sheet when it vanishes from the inbox, without discarding the work', async () => {
    // The inbox reports absence, not a reason — the device blocks further work either way.
    await saveLogSheet(localSheet())

    await mergeInboxIntoLocalSheets([])

    const sheet = await readSheet()
    expect(sheet.syncStatus).toBe('failed')
    expect(sheet.syncError).toBe(SYNC_OUTCOME_MESSAGES.REVOKED)
    expect(await storedReadings()).toEqual(READINGS)
  })

  it('does not relabel a sheet the device already knows was cancelled', async () => {
    // Once the truth is known — from opening the sheet online, or a CANCELLED submit outcome —
    // a later inbox pull must not talk it back down to the vaguer "reassigned" wording.
    await saveLogSheet(
      localSheet({ serverStatus: 'CANCELLED', syncStatus: 'failed', syncError: SYNC_OUTCOME_MESSAGES.CANCELLED })
    )

    await mergeInboxIntoLocalSheets([])

    expect((await readSheet()).syncError).toBe(SYNC_OUTCOME_MESSAGES.CANCELLED)
  })

  it('comes back to life when the supervisor extends the cancelled round', async () => {
    // `extend` un-cancels a sheet exactly as it un-expires one, and it returns to the inbox.
    await saveLogSheet(
      localSheet({
        serverStatus: 'CANCELLED',
        syncStatus: 'failed',
        syncError: SYNC_OUTCOME_MESSAGES.CANCELLED
      })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'IN_PROGRESS', dueAt: FUTURE })])

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('IN_PROGRESS')
    expect(sheet.syncError).toBeUndefined()
    expect(sheet.status).toBe('draft')
    expect(await storedReadings()).toEqual(READINGS)
    expect(canSubmitLogSheet(sheet, NOW)).toEqual({ ok: true })
  })

  it('never wipes the local draft on the way through, whatever the server says', async () => {
    // A cancel is reopenable, so the readings have to survive the cancelled state itself —
    // not only the extension that may or may not follow.
    await saveLogSheet(localSheet())

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'CANCELLED' })])

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('CANCELLED')
    expect(await storedReadings()).toEqual(READINGS)
  })
})

describe('a completion made offline and delivered late', () => {
  const submittedInTime = () =>
    localSheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'EXPIRED',
      syncError: SYNC_OUTCOME_MESSAGES.EXPIRED,
      dueAt: PAST,
      // Finished with fifteen minutes to spare; the tablet only found a signal afterwards.
      completedAt: PAST - 900_000,
      submittedAt: PAST - 900_000,
      clientActionId: 'rejected-action-id'
    })

  it('re-queues work that was finished inside the deadline', async () => {
    await saveLogSheet(submittedInTime())

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: PAST })])

    const sheet = await readSheet()
    expect(sheet.syncStatus).toBe('pending')
    expect(sheet.syncError).toBeUndefined()
  })

  it('mints a fresh idempotency key, or the retry reads as a replay of the rejected one', async () => {
    await saveLogSheet(submittedInTime())

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: PAST })])

    const sheet = await readSheet()
    expect(sheet.clientActionId).toBeDefined()
    expect(sheet.clientActionId).not.toBe('rejected-action-id')
  })

  it('leaves a genuinely late completion refused', async () => {
    // Finished an hour *after* the deadline. Reviving this would push work the server has
    // already ruled on, and it would be refused again on every pass forever.
    await saveLogSheet(
      localSheet({
        status: 'submitted',
        syncStatus: 'failed',
        serverStatus: 'EXPIRED',
        syncError: SYNC_OUTCOME_MESSAGES.EXPIRED,
        dueAt: PAST,
        completedAt: PAST + HOUR,
        submittedAt: PAST + HOUR,
        clientActionId: 'rejected-action-id'
      })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: PAST })])

    const sheet = await readSheet()
    expect(sheet.syncStatus).toBe('failed')
    expect(sheet.clientActionId).toBe('rejected-action-id')
  })

  it('refuses a queued completion once its deadline has passed with nothing delivered', async () => {
    // Submitted locally but never sent, and the deadline went by in the meantime.
    await saveLogSheet(
      localSheet({
        status: 'submitted',
        syncStatus: 'pending',
        dueAt: PAST,
        completedAt: PAST + HOUR,
        submittedAt: PAST + HOUR
      })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'EXPIRED', dueAt: PAST })])

    const sheet = await readSheet()
    expect(sheet.serverStatus).toBe('EXPIRED')
    expect(sheet.syncStatus).toBe('failed')
    expect(sheet.syncError).toBe(SYNC_OUTCOME_MESSAGES.EXPIRED)
    expect(await storedReadings()).toEqual(READINGS)
  })

  it('does not resolve an unsent completion from the inbox, whatever the server shows', async () => {
    // Only the submit endpoint may decide this one: it is the only path that can record a
    // server-side void when the answer is no. A bundle merge marking it synced would discard
    // the operator's work with no error and no record anywhere.
    await saveLogSheet(
      localSheet({
        status: 'submitted',
        syncStatus: 'pending',
        completedAt: PAST,
        submittedAt: PAST
      })
    )

    await mergeInboxIntoLocalSheets([inboxBundle({ status: 'SUBMITTED' })])

    const sheet = await readSheet()
    expect(sheet.status).toBe('submitted')
    expect(sheet.syncStatus).toBe('pending')
    expect(await storedReadings()).toEqual(READINGS)
  })
})

describe('an ordinary pass over healthy work', () => {
  it('refreshes what the server owns and invents no failure', async () => {
    await saveLogSheet(localSheet())

    await mergeInboxIntoLocalSheets([inboxBundle({ dueAt: FUTURE + HOUR })])

    const sheet = await readSheet()
    expect(sheet.dueAt).toBe(FUTURE + HOUR)
    expect(sheet.serverStatus).toBe('IN_PROGRESS')
    expect(sheet.syncStatus).toBe('pending')
    expect(sheet.syncError).toBeUndefined()
    expect(await storedReadings()).toEqual(READINGS)
  })

  it('survives repeated passes without drifting', async () => {
    // Sync runs every 30 seconds all shift. A merge that is not idempotent shows up as a row
    // that changes state on its own between two identical server responses.
    await saveLogSheet(localSheet())

    await mergeInboxIntoLocalSheets([inboxBundle()])
    const first = await readSheet()
    await mergeInboxIntoLocalSheets([inboxBundle()])
    const second = await readSheet()

    expect(second.status).toBe(first.status)
    expect(second.syncStatus).toBe(first.syncStatus)
    expect(second.serverStatus).toBe(first.serverStatus)
    expect(second.syncError).toBe(first.syncError)
    expect(second.entries[0]?.formData).toEqual(READINGS)
  })
})

// ---------------------------------------------------------------------------

describe('judging lateness by when the work was done, not when the link came back', () => {
  const inTime = { dueAt: NOW, completedAt: NOW - 60_000, submittedAt: undefined }
  const late = { dueAt: NOW, completedAt: NOW + 60_000, submittedAt: undefined }

  it('counts a completion finished before the deadline as in time', () => {
    expect(completedWithinDeadline(inTime)).toBe(true)
  })

  it('counts one finished after it as late', () => {
    expect(completedWithinDeadline(late)).toBe(false)
  })

  it('falls back to the submission stamp when there is no completion stamp', () => {
    expect(completedWithinDeadline({ dueAt: NOW, completedAt: undefined, submittedAt: NOW - 1 })).toBe(true)
  })

  it('says no when there is nothing to compare', () => {
    expect(completedWithinDeadline({ dueAt: undefined, completedAt: NOW, submittedAt: undefined })).toBe(false)
    expect(completedWithinDeadline({ dueAt: NOW, completedAt: undefined, submittedAt: undefined })).toBe(false)
  })

  it('keeps an on-time offline completion sync-eligible long after the wall clock passes', () => {
    // The rule that makes offline work deliverable at all: the operator finished in time, and
    // the walk back to signal must not cost them the round.
    const sheet = {
      status: 'submitted' as const,
      dueAt: PAST,
      completedAt: PAST - 60_000,
      submittedAt: PAST - 60_000,
      serverStatus: 'IN_PROGRESS' as const
    }
    expect(isLogSheetExpiredForSync(sheet, NOW)).toBe(false)
  })

  it('still refuses one finished after the deadline', () => {
    const sheet = {
      status: 'submitted' as const,
      dueAt: PAST,
      completedAt: PAST + 60_000,
      submittedAt: PAST + 60_000,
      serverStatus: 'IN_PROGRESS' as const
    }
    expect(isLogSheetExpiredForSync(sheet, NOW)).toBe(true)
  })

  it('honours an explicit server EXPIRED regardless of the stamps', () => {
    const sheet = {
      status: 'submitted' as const,
      dueAt: FUTURE,
      completedAt: NOW,
      submittedAt: NOW,
      serverStatus: 'EXPIRED' as const
    }
    expect(isLogSheetExpiredForSync(sheet, NOW)).toBe(true)
  })

  it('judges a draft by the wall clock, since there is no completion to date it by', () => {
    expect(
      isLogSheetExpiredForSync(
        { status: 'draft', dueAt: PAST, completedAt: undefined, submittedAt: undefined, serverStatus: 'IN_PROGRESS' },
        NOW
      )
    ).toBe(true)
  })
})
