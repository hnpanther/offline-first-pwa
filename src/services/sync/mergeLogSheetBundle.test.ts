import { describe, expect, it } from 'vitest'
import {
  mapServerEntryToLocal,
  mergeEntriesPreservingFormData
} from '@/services/sync/mergeLogSheetBundle'
import type { LogSheetEntryData } from '@/types'
import type { ServerLogSheetEntry } from '@/services/api'

const serverEntry: ServerLogSheetEntry = {
  assetId: 42,
  assetName: 'Pump A',
  subFunctionCode: 'SF-01',
  subFunctionTag: 'T1',
  classId: 7,
  formData: { temp: 10 },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_050_000
}

describe('mapServerEntryToLocal', () => {
  it('maps server timestamps when no local entry exists', () => {
    const local = mapServerEntryToLocal(serverEntry)

    expect(local.createdAt).toBe(1_700_000_000_000)
    expect(local.updatedAt).toBe(1_700_000_050_000)
    expect(local.formData).toEqual({ temp: 10 })
  })

  it('preserves local form data and timestamps over server', () => {
    const existing: LogSheetEntryData = {
      assetId: '42',
      assetName: 'Pump A',
      subFunctionCode: 'SF-01',
      subFunctionTag: 'T1',
      classId: '7',
      formData: { temp: 25 },
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_100_000
    }

    const local = mapServerEntryToLocal(serverEntry, existing)

    expect(local.formData).toEqual({ temp: 25 })
    expect(local.createdAt).toBe(1_600_000_000_000)
    expect(local.updatedAt).toBe(1_600_000_100_000)
  })
})

describe('mergeEntriesPreservingFormData', () => {
  it('merges by asset id', () => {
    const existing: LogSheetEntryData[] = [
      {
        assetId: '42',
        assetName: 'Pump A',
        subFunctionCode: 'SF-01',
        subFunctionTag: 'T1',
        classId: '7',
        formData: { temp: 30 },
        createdAt: 1_600_000_000_000,
        updatedAt: 1_600_000_200_000
      }
    ]

    const merged = mergeEntriesPreservingFormData([serverEntry], existing)

    expect(merged).toHaveLength(1)
    expect(merged[0].formData).toEqual({ temp: 30 })
    expect(merged[0].createdAt).toBe(1_600_000_000_000)
    expect(merged[0].updatedAt).toBe(1_600_000_200_000)
  })

  it('uses server form data when preserveLocal is false', () => {
    const existing: LogSheetEntryData[] = [
      {
        assetId: '42',
        assetName: 'Pump A',
        subFunctionCode: 'SF-01',
        subFunctionTag: 'T1',
        classId: '7',
        formData: { temp: 30 },
        createdAt: 1_600_000_000_000,
        updatedAt: 1_600_000_200_000
      }
    ]

    const merged = mergeEntriesPreservingFormData([serverEntry], existing, {
      preserveLocal: false
    })

    expect(merged[0].formData).toEqual({ temp: 10 })
    expect(merged[0].createdAt).toBe(1_700_000_000_000)
    expect(merged[0].updatedAt).toBe(1_700_000_050_000)
  })
})
