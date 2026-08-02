import { describe, expect, it } from 'vitest'
import { stripEntryFormData, sheetHasLocalEntryData, isAssigneeMismatch } from '@/utils/logSheetLocalData'
import type { LogSheetEntryData } from '@/types'

describe('stripEntryFormData', () => {
  it('clears formData, timestamps, and filledVia', () => {
    const entries: LogSheetEntryData[] = [
      {
        assetId: '42',
        assetName: 'Pump A',
        subFunctionCode: 'SF-01',
        subFunctionTag: 'T1',
        classId: '7',
        formData: { temp: 25 },
        createdAt: 1_600_000_000_000,
        updatedAt: 1_600_000_100_000,
        filledVia: 'manual'
      }
    ]

    const stripped = stripEntryFormData(entries)

    expect(stripped[0].formData).toEqual({})
    expect(stripped[0].createdAt).toBeUndefined()
    expect(stripped[0].updatedAt).toBeUndefined()
    expect(stripped[0].filledVia).toBeUndefined()
    // Everything else (identity fields) untouched.
    expect(stripped[0].assetId).toBe('42')
    expect(stripped[0].assetName).toBe('Pump A')
  })
})

describe('sheetHasLocalEntryData', () => {
  it('is true when any entry has meaningful form data', () => {
    expect(
      sheetHasLocalEntryData({
        entries: [
          { assetId: '1', assetName: '', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: {} },
          { assetId: '2', assetName: '', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: { temp: 1 } }
        ]
      })
    ).toBe(true)
  })

  it('is false when all entries are blank', () => {
    expect(
      sheetHasLocalEntryData({
        entries: [
          { assetId: '1', assetName: '', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: {} }
        ]
      })
    ).toBe(false)
  })
})

describe('isAssigneeMismatch', () => {
  it('is false when there is no server assignee to compare against', () => {
    expect(isAssigneeMismatch({ assigneeUserId: '5' }, null)).toBe(false)
  })

  it('is true when local assigneeUserId differs from server', () => {
    expect(isAssigneeMismatch({ assigneeUserId: '5' }, '9')).toBe(true)
  })

  it('is true when local owner differs from server even if assignee matches', () => {
    expect(isAssigneeMismatch({ assigneeUserId: '9', localOwnerUserId: '5' }, '9')).toBe(true)
  })

  it('is false when both local fields align with the server assignee', () => {
    expect(isAssigneeMismatch({ assigneeUserId: '9', localOwnerUserId: '9' }, '9')).toBe(false)
  })
})
