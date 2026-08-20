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

  it("drops the name once the operator's own unsent edit is what is displayed", () => {
    // The local draft wins here, so the values on screen are this operator's. Carrying the
    // previous operator's name onto them would be a lie in the other direction — and would make
    // an operator think their own reading had already been recorded by somebody else.
    const existing: LogSheetEntryData = {
      assetId: '1',
      assetName: 'Pump A',
      subFunctionCode: 'PK-01',
      subFunctionTag: 'PK-01',
      classId: '7',
      formData: { temp: '99' }
    }

    const local = mapServerEntryToLocal(serverEntry(), existing, true)

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
