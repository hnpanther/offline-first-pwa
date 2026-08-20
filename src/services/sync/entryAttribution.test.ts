import { describe, expect, it } from 'vitest'
import type { ServerLogSheetEntry } from '@/services/api'
import type { LogSheetEntryData } from '@/types'

import { mapServerEntryToLocal } from './mergeLogSheetBundle'

/**
 * Who filled an entry, as the device stores it.
 *
 * The case this exists for: a supervisor reopens a submitted sheet and reassigns it so a second
 * operator can redo part of it. That operator's device downloads the bundle and their form comes
 * up already full of the first operator's readings — which is intended, they need to see what is
 * already there — but nothing on screen said whose readings they were.
 *
 * The server has always known: it re-stamps `filled_by_user_id` only when a value actually
 * changes, so an untouched asset keeps naming whoever really recorded it. What was missing was a
 * *name* on the wire (the bundle carried only an internal user id, which names nobody) and
 * anywhere on the device to put it.
 */
describe('entry attribution through the bundle merge', () => {
  const serverEntry = (overrides: Partial<ServerLogSheetEntry> = {}): ServerLogSheetEntry => ({
    assetId: 1,
    assetName: 'Pump A',
    subFunctionCode: 'PK-01',
    subFunctionTag: 'PK-01',
    classId: 7,
    formData: { temp: '10' },
    filledByName: 'اپراتور اول',
    ...overrides
  })

  it('keeps the name the server reports for a freshly downloaded entry', () => {
    const local = mapServerEntryToLocal(serverEntry())

    expect(local.filledByName).toBe('اپراتور اول')
    expect(local.formData).toEqual({ temp: '10' })
  })

  it('is undefined when nobody has filled the entry yet', () => {
    const local = mapServerEntryToLocal(serverEntry({ filledByName: null, formData: {} }))

    expect(local.filledByName).toBeUndefined()
  })

  it('keeps naming the previous operator while their values are the ones on screen', () => {
    // Operator 2's device has the sheet but no local edits, so the server's values win — and
    // they are operator 1's. The label must say so.
    const existing: LogSheetEntryData = {
      assetId: '1',
      assetName: 'Pump A',
      subFunctionCode: 'PK-01',
      subFunctionTag: 'PK-01',
      classId: '7',
      formData: {}
    }

    const local = mapServerEntryToLocal(serverEntry(), existing, true)

    expect(local.formData).toEqual({ temp: '10' })
    expect(local.filledByName).toBe('اپراتور اول')
  })

  /**
   * The regression that mattered most: a plain refresh used to erase the label.
   *
   * After the first sync the local row holds the server's own values. The old code decided
   * "did the server win?" with `formData === serverForm`, and on the second sync the local
   * object is a different instance holding identical data — so identity failed, the local side
   * "won", and the name was dropped. Nobody had edited anything.
   */
  it('keeps the name across a second sync when nothing was edited', () => {
    const first = mapServerEntryToLocal(serverEntry())
    expect(first.filledByName).toBe('اپراتور اول')

    // Exactly what happens on the next bundle refresh: the stored row is passed back in.
    const second = mapServerEntryToLocal(serverEntry(), first, true)

    expect(second.formData).toEqual({ temp: '10' })
    expect(second.filledByName)
      .toBe('اپراتور اول')
  })

  it('keeps the name across many syncs, not just the second', () => {
    let local = mapServerEntryToLocal(serverEntry())
    for (let i = 0; i < 5; i++) {
      local = mapServerEntryToLocal(serverEntry(), local, true)
    }
    expect(local.filledByName).toBe('اپراتور اول')
  })

  /**
   * An unsent local draft on an entry that is still the previous operator's work keeps naming
   * them. It is the *save* that clears the label — at the moment the values become this
   * operator's — not the mere existence of a local row.
   */
  it("keeps the stored name while a local draft is what is displayed", () => {
    const existing: LogSheetEntryData = {
      assetId: '1',
      assetName: 'Pump A',
      subFunctionCode: 'PK-01',
      subFunctionTag: 'PK-01',
      classId: '7',
      formData: { temp: '99' },
      filledByName: 'اپراتور اول'
    }

    const local = mapServerEntryToLocal(serverEntry(), existing, true)

    expect(local.formData).toEqual({ temp: '99' })
    expect(local.filledByName).toBe('اپراتور اول')
  })

  /**
   * And once the save path has cleared it, a later sync must not resurrect it from the server
   * copy while the local values are still the unsent ones.
   */
  it('does not resurrect a name the save path cleared', () => {
    const savedByThisOperator: LogSheetEntryData = {
      assetId: '1',
      assetName: 'Pump A',
      subFunctionCode: 'PK-01',
      subFunctionTag: 'PK-01',
      classId: '7',
      formData: { temp: '99' },
      filledByName: undefined
    }

    const local = mapServerEntryToLocal(serverEntry(), savedByThisOperator, true)

    expect(local.formData).toEqual({ temp: '99' })
    expect(local.filledByName).toBeUndefined()
  })

  it('takes the server name when the local draft is deliberately discarded', () => {
    // preserveLocal = false is the "server wins" path (a fresh pull after submit). The values
    // are the server's, so the attribution must be too.
    const existing: LogSheetEntryData = {
      assetId: '1',
      assetName: 'Pump A',
      subFunctionCode: 'PK-01',
      subFunctionTag: 'PK-01',
      classId: '7',
      formData: { temp: '99' }
    }

    const local = mapServerEntryToLocal(serverEntry(), existing, false)

    expect(local.formData).toEqual({ temp: '10' })
    expect(local.filledByName).toBe('اپراتور اول')
  })

  it('leaves every other mapped field alone', () => {
    // A regression guard: this change touches a mapper the whole sync path depends on.
    const local = mapServerEntryToLocal(serverEntry({ nfcTagId: 'TAG-9', nfcSerial: '04:11' }))

    expect(local.assetId).toBe('1')
    expect(local.assetName).toBe('Pump A')
    expect(local.subFunctionCode).toBe('PK-01')
    expect(local.nfcTagId).toBe('TAG-9')
    expect(local.nfcSerial).toBe('04:11')
    expect(local.classId).toBe('7')
  })
})
