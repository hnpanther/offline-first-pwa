import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, updateLogSheet } from '@/services/storage'
import type { LogSheet } from '@/types'

/**
 * Two writers, one row.
 *
 * <p>A log sheet is written from two directions at once: the fill page saving an entry the
 * operator just typed, and a sync tick updating the same row's bookkeeping. Most of that is safe
 * because `updateLogSheet` uses Dexie's field-level `update`, which IndexedDB applies atomically —
 * two writers touching different fields both survive.
 *
 * <p>One path cannot use it. Clearing `syncError` needs a whole-row `put`, because `update`
 * cannot remove a property: assigning `undefined` leaves the key present, and the status helpers
 * read that as "there is still an error". A `put` is a read-modify-write, and outside a
 * transaction a save landing between the read and the write is discarded — a reading the operator
 * watched being saved, gone, with no error and nothing to look at.
 *
 * <p>These tests pin the transaction that closes that window, and — just as important — that the
 * ordinary path still merges concurrent writers rather than serialising them.
 */

const NOW = 1_700_000_000_000

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    status: 'draft',
    syncStatus: 'pending',
    syncError: 'قبلاً منقضی شده بود',
    dueAt: NOW + 3_600_000,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: {}
      }
    ],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function withReading(value: string) {
  return [
    {
      assetId: '7',
      assetName: 'پمپ ۱',
      subFunctionCode: 'SF-1',
      subFunctionTag: 'TAG-1',
      classId: '2',
      formData: { temp: value },
      locallyEditedAt: NOW
    }
  ]
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
})

describe('clearing syncError', () => {
  it('removes the key rather than leaving it undefined', async () => {
    // The reason this path needs a `put` at all. A row whose `syncError` key survives with an
    // undefined value still reads as failed to anything doing `syncError != null` — and worse,
    // to anything doing `'syncError' in sheet`.
    await saveLogSheet(sheet())

    await updateLogSheet('local-1', { syncError: undefined })

    const after = await getLogSheet('local-1')
    expect(after).toBeDefined()
    expect('syncError' in after!).toBe(false)
  })

  it('does not discard a reading saved at the same moment', async () => {
    // The race itself: the operator saves an entry while a sync tick clears a stale error on the
    // same sheet. Both writes are started before either finishes.
    await saveLogSheet(sheet())

    await Promise.all([
      updateLogSheet('local-1', { entries: withReading('42') }),
      updateLogSheet('local-1', { syncError: undefined })
    ])

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: '42' })
    expect('syncError' in after!).toBe(false)
  })

  it('does not discard a reading saved the other way round either', async () => {
    // Order reversed, because a race that only survives one interleaving is not fixed.
    await saveLogSheet(sheet())

    await Promise.all([
      updateLogSheet('local-1', { syncError: undefined }),
      updateLogSheet('local-1', { entries: withReading('7') })
    ])

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: '7' })
    expect('syncError' in after!).toBe(false)
  })

  it('keeps the other fields the clearing write carried', async () => {
    await saveLogSheet(sheet())

    await updateLogSheet('local-1', {
      syncError: undefined,
      syncStatus: 'pending',
      clientActionId: 'fresh-action'
    })

    const after = await getLogSheet('local-1')
    expect(after?.syncStatus).toBe('pending')
    expect(after?.clientActionId).toBe('fresh-action')
    expect('syncError' in after!).toBe(false)
  })
})

describe('the ordinary update path', () => {
  it('merges two writers touching different fields', async () => {
    // This is what `update` buys and a whole-row `put` would lose. If this ever starts failing,
    // something has replaced the field-level patch with a rebuilt row.
    await saveLogSheet(sheet({ syncError: undefined }))

    await Promise.all([
      updateLogSheet('local-1', { entries: withReading('11') }),
      updateLogSheet('local-1', { serverStatus: 'IN_PROGRESS' })
    ])

    const after = await getLogSheet('local-1')
    expect(after?.entries[0].formData).toEqual({ temp: '11' })
    expect(after?.serverStatus).toBe('IN_PROGRESS')
  })

  it('refuses to write a sheet that is not there', async () => {
    await expect(updateLogSheet('missing', { syncError: undefined })).rejects.toThrow(/not found/)
  })
})
