import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import {
  getLogSheet,
  resetLogSheetToOpenDraft,
  saveLogSheet
} from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet } from '@/types'

/**
 * A completion the operator delivered, which a supervisor then reopened
 * (`POST /log-sheets/{id}/reopen`) so it can be corrected before a new deadline.
 *
 * Two halves, and keeping them apart is the whole design:
 *
 *  - **Detection is passive.** The ordinary inbox merge writes the fresh `serverStatus` and
 *    `dueAt` onto the local row and touches nothing else. It must never turn a delivered
 *    completion back into editable work on its own, because the inbox response it merges may
 *    have been read from the server moments before this device's own submission landed.
 *  - **Resuming is explicit.** The fill page re-checks a freshly fetched bundle, and only then
 *    runs `resetLogSheetToOpenDraft` + a bundle apply, in that order.
 */

const SESSION_USER_ID = '7'
const SERVER_ID = '55'
const ORIGINAL_DUE_AT = 1_700_000_500_000
const REOPENED_DUE_AT = 1_700_100_000_000
const SUBMITTED_AT = 1_700_000_400_000

function syncedCompletion(overrides: Partial<LogSheet> = {}): LogSheet {
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
    dueAt: ORIGINAL_DUE_AT,
    submittedAt: SUBMITTED_AT,
    completedAt: SUBMITTED_AT,
    syncedAt: SUBMITTED_AT + 60_000,
    clientActionId: 'delivered-action-id',
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 42 },
        filledVia: 'manual',
        createdAt: SUBMITTED_AT - 10_000,
        updatedAt: SUBMITTED_AT
      }
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: SUBMITTED_AT,
    ...overrides
  } as LogSheet
}

/** What the server returns for that sheet after a supervisor reopened it. */
function reopenedBundle(): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      // Reopen moves the sheet back to IN_PROGRESS and clears its submission stamps.
      status: 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: REOPENED_DUE_AT,
      submittedAt: null,
      completedAt: null,
      completedByUserId: null,
      syncedAt: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_900_000
    },
    entries: [
      {
        assetId: 7,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: 2,
        // The server kept the delivered readings — reopen never discards them.
        formData: { temp: 42 }
      }
    ],
    context: null
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
})

describe('inbox merge of a reopened completion (detection only)', () => {
  it('records the new server status and deadline without resurrecting the work', async () => {
    await saveLogSheet(syncedCompletion())

    await applyLogSheetBundle(reopenedBundle())

    const merged = await getLogSheet('local-1')
    expect(merged?.serverStatus).toBe('IN_PROGRESS')
    expect(merged?.dueAt).toBe(REOPENED_DUE_AT)
    // The completion really was delivered; only an explicit, server-verified action may undo it.
    expect(merged?.status).toBe('submitted')
    expect(merged?.syncStatus).toBe('synced')
  })

  it('keeps the operator\'s own readings and their local-only capture method', async () => {
    await saveLogSheet(syncedCompletion())

    await applyLogSheetBundle(reopenedBundle())

    const merged = await getLogSheet('local-1')
    expect(merged?.entries[0].formData).toEqual({ temp: 42 })
    // `filledVia` never round-trips through the server, so a merge that drops it would relabel
    // a manually-completed asset as NFC-scanned on the next submit.
    expect(merged?.entries[0].filledVia).toBe('manual')
  })

  it('still refuses to touch a completion that has not been delivered yet', async () => {
    // Unchanged invariant, re-pinned here because this feature works next door to it: a
    // submitted+pending sheet is resolved by the batch-submit outcome and nothing else.
    await saveLogSheet(
      syncedCompletion({ syncStatus: 'pending', syncedAt: undefined, serverStatus: 'IN_PROGRESS' })
    )

    await applyLogSheetBundle(reopenedBundle())

    const untouched = await getLogSheet('local-1')
    expect(untouched?.status).toBe('submitted')
    expect(untouched?.syncStatus).toBe('pending')
    expect(untouched?.dueAt).toBe(ORIGINAL_DUE_AT)
    expect(untouched?.clientActionId).toBe('delivered-action-id')
  })
})

describe('resuming a reopened completion (reset, then apply the bundle)', () => {
  async function resume(): Promise<LogSheet | undefined> {
    // Exactly what LogSheetFillPage.handleContinueReopened does once the live bundle passes
    // canContinueReopenedLogSheet.
    await resetLogSheetToOpenDraft('local-1')
    await applyLogSheetBundle(reopenedBundle())
    return getLogSheet('local-1')
  }

  it('hands the sheet back as an editable draft', async () => {
    await saveLogSheet(syncedCompletion())

    const resumed = await resume()

    expect(resumed?.status).toBe('draft')
    expect(resumed?.syncStatus).toBe('pending')
  })

  it('keeps the readings, so the operator corrects rather than re-walks the round', async () => {
    await saveLogSheet(syncedCompletion())

    const resumed = await resume()

    expect(resumed?.entries[0].formData).toEqual({ temp: 42 })
    expect(resumed?.entries[0].filledVia).toBe('manual')
  })

  it('drops the delivered submission stamps, including the idempotency key', async () => {
    // Reusing the id of the submission the server already recorded would let its replay guard
    // answer "already processed" and silently drop the corrected values.
    await saveLogSheet(syncedCompletion())

    const resumed = await resume()

    expect(resumed?.clientActionId).toBeUndefined()
    expect(resumed?.submittedAt).toBeUndefined()
    expect(resumed?.completedAt).toBeUndefined()
    expect(resumed?.syncedAt).toBeUndefined()
  })

  it('carries the new deadline and server status onto the resumed draft', async () => {
    await saveLogSheet(syncedCompletion())

    const resumed = await resume()

    expect(resumed?.dueAt).toBe(REOPENED_DUE_AT)
    expect(resumed?.serverStatus).toBe('IN_PROGRESS')
  })

  it('keeps the sheet identified and owned, so the resubmission targets it as the same user', async () => {
    await saveLogSheet(syncedCompletion())

    const resumed = await resume()

    expect(resumed?.serverId).toBe(SERVER_ID)
    expect(resumed?.localOwnerUserId).toBe(SESSION_USER_ID)
    expect(resumed?.assigneeUserId).toBe(SESSION_USER_ID)
  })

  it('leaves no failure banner behind from anything the row was carrying', async () => {
    await saveLogSheet(
      syncedCompletion({ syncError: 'خطای قدیمی', lastSubmitOutcome: 'VALIDATION_ERROR' })
    )

    const resumed = await resume()

    expect(resumed?.syncError).toBeUndefined()
    expect(resumed?.lastSubmitOutcome).toBeUndefined()
  })

  it('is order-dependent: applying the bundle first would change nothing', async () => {
    // The reverse order hits applyLogSheetBundle's `synced` path, which deliberately leaves a
    // delivered completion alone — a silent no-op that would look like a broken button.
    await saveLogSheet(syncedCompletion())

    await applyLogSheetBundle(reopenedBundle())
    const beforeReset = await getLogSheet('local-1')
    expect(beforeReset?.status).toBe('submitted')

    await resetLogSheetToOpenDraft('local-1')
    expect((await getLogSheet('local-1'))?.status).toBe('draft')
  })
})

describe('retention of a reopened completion', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('survives the 24h purge that removes ordinary delivered completions', async () => {
    // One hour before the reopened deadline, which is also more than a day after the
    // completion synced — so the ordinary retention rule would already have deleted it.
    const now = REOPENED_DUE_AT - 60 * 60 * 1000
    expect(now - (SUBMITTED_AT + 60_000)).toBeGreaterThan(DAY)

    await saveLogSheet(syncedCompletion({ serverStatus: 'IN_PROGRESS', dueAt: REOPENED_DUE_AT }))
    // Same clock, same age, no reopen — the control that proves what kept the other one.
    await saveLogSheet(syncedCompletion({ id: 'local-2', localId: 'local-2', serverId: '56' }))

    const deleted = await cleanupLocalLogSheets(now)

    expect(deleted).toBe(1)
    expect(await getLogSheet('local-1')).toBeTruthy()
    expect(await getLogSheet('local-2')).toBeUndefined()
  })

  it('still purges an ordinary delivered completion', async () => {
    await saveLogSheet(syncedCompletion())

    const deleted = await cleanupLocalLogSheets(SUBMITTED_AT + 2 * DAY)

    expect(deleted).toBe(1)
    expect(await getLogSheet('local-1')).toBeUndefined()
  })

  it('purges a reopened sheet again once its new deadline has passed unused', async () => {
    // It is history at that point: the operator never resumed it, and the server will have
    // expired it on its own side too.
    await saveLogSheet(syncedCompletion({ serverStatus: 'IN_PROGRESS', dueAt: REOPENED_DUE_AT }))

    const deleted = await cleanupLocalLogSheets(REOPENED_DUE_AT + 2 * DAY)

    expect(deleted).toBe(1)
    expect(await getLogSheet('local-1')).toBeUndefined()
  })
})
