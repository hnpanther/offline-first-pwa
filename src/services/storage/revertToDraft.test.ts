import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, revertLogSheetToDraft, saveLogSheet } from '@/services/storage'
import type { LogSheet } from '@/types'

/**
 * Reverting a rejected submission back to an editable draft.
 *
 * The sync-critical part is the idempotency key. The server records `clientActionId` as a used
 * key on several paths, so a corrected resubmission carrying the *old* id can be recognised as
 * a replay and answered "already processed" — reporting success while never storing the
 * corrected values. Silent data loss, and the operator would have no way of knowing.
 */

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'sheet-1',
    localId: 'local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    status: 'submitted',
    syncStatus: 'failed',
    syncError: 'Form data validation failed (asset ...)',
    lastSubmitOutcome: 'VALIDATION_ERROR',
    clientActionId: 'stale-action-id',
    entries: [
      { assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { temp: 42 } }
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  } as LogSheet
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
})

describe('revertLogSheetToDraft after a rejected submission', () => {
  it('makes the sheet editable again', async () => {
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    const reverted = await getLogSheet('local-1')
    expect(reverted?.status).toBe('draft')
    expect(reverted?.syncStatus).toBe('pending')
  })

  it('drops the stale clientActionId so the resubmission cannot be read as a replay', async () => {
    // The whole reason a retry button was the wrong fix: resending the old id lets the
    // server's replay guard answer "already processed" and quietly drop the corrected values.
    // Clearing it here forces the submit path to mint a new one.
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    expect((await getLogSheet('local-1'))?.clientActionId).toBeUndefined()
  })

  it('clears the failure so the operator is not fixing fields under a red banner', async () => {
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    const reverted = await getLogSheet('local-1')
    expect(reverted?.syncError).toBeUndefined()
    expect(reverted?.lastSubmitOutcome).toBeUndefined()
  })

  it('keeps the readings the operator already entered', async () => {
    // They are correcting one field, not starting the round again. Losing the rest would make
    // the correction path worse than the dead end it replaces.
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    const reverted = await getLogSheet('local-1')
    expect(reverted?.entries[0].formData).toEqual({ temp: 42 })
  })

  it('keeps the server id, so the corrected submission still targets the same sheet', async () => {
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    expect((await getLogSheet('local-1'))?.serverId).toBe('55')
  })

  it('drops the id again on a second correction', async () => {
    // Two corrections in a row is entirely plausible on a sheet with several bad fields, and
    // the second resubmission must be as new as the first.
    await saveLogSheet(sheet())
    await revertLogSheetToDraft('local-1')

    await db.logSheets.where('localId').equals('local-1').modify({
      status: 'submitted',
      syncStatus: 'failed',
      lastSubmitOutcome: 'VALIDATION_ERROR',
      clientActionId: 'second-stale-id'
    })
    await revertLogSheetToDraft('local-1')

    expect((await getLogSheet('local-1'))?.clientActionId).toBeUndefined()
  })
})
