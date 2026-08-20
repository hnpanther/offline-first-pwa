import { describe, expect, it } from 'vitest'
import { applyEntrySaveTimestamps, applyOperatorEntrySave, hasEntryFormData } from '@/utils/entryTimestamps'
import type { LogSheetEntryData } from '@/types'

const baseEntry: LogSheetEntryData = {
  assetId: '1',
  assetName: 'Pump',
  subFunctionCode: 'SF',
  subFunctionTag: 'T1',
  classId: '7',
  formData: {}
}

describe('hasEntryFormData', () => {
  it('returns false for empty form', () => {
    expect(hasEntryFormData({})).toBe(false)
    expect(hasEntryFormData({ temp: '' })).toBe(false)
  })

  it('returns true when a field has a value', () => {
    expect(hasEntryFormData({ temp: 22 })).toBe(true)
    expect(hasEntryFormData({ tags: ['a'] })).toBe(true)
  })
})

describe('applyEntrySaveTimestamps', () => {
  it('sets createdAt on first save with data', () => {
    const now = 1_700_000_000_000
    const result = applyEntrySaveTimestamps(baseEntry, { temp: 20 }, now)

    expect(result.createdAt).toBe(now)
    expect(result.updatedAt).toBeUndefined()
    expect(result.formData).toEqual({ temp: 20 })
  })

  it('sets updatedAt on subsequent edits and keeps createdAt', () => {
    const created = 1_700_000_000_000
    const now = 1_700_000_100_000
    const entry: LogSheetEntryData = {
      ...baseEntry,
      formData: { temp: 20 },
      createdAt: created
    }

    const result = applyEntrySaveTimestamps(entry, { temp: 25 }, now)

    expect(result.createdAt).toBe(created)
    expect(result.updatedAt).toBe(now)
  })

  it('does not touch timestamps when saving empty form', () => {
    const entry: LogSheetEntryData = {
      ...baseEntry,
      createdAt: 100,
      updatedAt: 200
    }

    const result = applyEntrySaveTimestamps(entry, {}, 999)

    expect(result.createdAt).toBe(100)
    expect(result.updatedAt).toBe(200)
    expect(result.formData).toEqual({})
  })
})

describe('applyOperatorEntrySave', () => {
  const previousOperatorsEntry: LogSheetEntryData = {
    assetId: '1',
    assetName: 'Pump A',
    subFunctionCode: 'PK-01',
    subFunctionTag: 'PK-01',
    classId: '7',
    formData: { temp: '10' },
    filledByName: 'اپراتور اول',
    createdAt: 1_000,
    updatedAt: 1_000
  }

  /**
   * The bug this function exists to prevent.
   *
   * The save used to spread the previous entry and set only `filledVia`, so `filledByName`
   * survived: operator 2 rewrote the reading and the screen went on crediting operator 1 —
   * worse than showing no name at all, because it is confidently wrong.
   */
  it("clears the previous operator's name once this operator saves", () => {
    const saved = applyOperatorEntrySave(previousOperatorsEntry, { temp: '99' }, 'nfc', 2_000)

    expect(saved.filledByName).toBeUndefined()
    expect(saved.formData).toEqual({ temp: '99' })
  })

  it('records how this operator captured it', () => {
    expect(applyOperatorEntrySave(previousOperatorsEntry, { temp: '99' }, 'manual', 2_000).filledVia)
      .toBe('manual')
  })

  it('still applies the timestamp rules it wraps', () => {
    const saved = applyOperatorEntrySave(previousOperatorsEntry, { temp: '99' }, 'nfc', 2_000)

    expect(saved.createdAt).toBe(1_000)
    expect(saved.updatedAt).toBe(2_000)
  })

  it('leaves the identifying fields untouched', () => {
    const saved = applyOperatorEntrySave(previousOperatorsEntry, { temp: '99' }, 'nfc', 2_000)

    expect(saved.assetId).toBe('1')
    expect(saved.assetName).toBe('Pump A')
    expect(saved.subFunctionCode).toBe('PK-01')
    expect(saved.classId).toBe('7')
  })

  it('clears the name even when the operator saves an empty form', () => {
    // Clearing a reading is still this operator's decision about this asset.
    const saved = applyOperatorEntrySave(previousOperatorsEntry, {}, 'nfc', 2_000)

    expect(saved.filledByName).toBeUndefined()
    expect(saved.formData).toEqual({})
  })
})
