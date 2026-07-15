import { describe, expect, it } from 'vitest'
import { applyEntrySaveTimestamps, hasEntryFormData } from '@/utils/entryTimestamps'
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
