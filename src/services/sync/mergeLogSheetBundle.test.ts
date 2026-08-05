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

describe('nfcSerial (physical chip UID)', () => {
  it('carries the serial down from the server so an offline scan can match it', () => {
    const local = mapServerEntryToLocal({ ...serverEntry, nfcSerial: '00:aa:34:9f:12:cd' })

    expect(local.nfcSerial).toBe('00:aa:34:9f:12:cd')
  })

  it('leaves the serial undefined when the asset has none', () => {
    expect(mapServerEntryToLocal(serverEntry).nfcSerial).toBeUndefined()
    expect(mapServerEntryToLocal({ ...serverEntry, nfcSerial: null }).nfcSerial).toBeUndefined()
  })

  it('is server-authoritative: a refresh overwrites the local copy, unlike formData', () => {
    const existing: LogSheetEntryData = {
      assetId: '42',
      assetName: 'Pump A',
      subFunctionCode: 'SF-01',
      subFunctionTag: 'T1',
      nfcSerial: '00:stale:value',
      classId: '7',
      formData: { temp: 25 }
    }

    const local = mapServerEntryToLocal({ ...serverEntry, nfcSerial: '00:fresh:value' }, existing)

    expect(local.nfcSerial).toBe('00:fresh:value')
    // …while the operator's own readings are still preserved, which is the whole point
    // of preserveLocal — the two must not be conflated.
    expect(local.formData).toEqual({ temp: 25 })
  })

  it('clears a stale local serial when the server no longer reports one', () => {
    const existing: LogSheetEntryData = {
      assetId: '42',
      assetName: 'Pump A',
      subFunctionCode: 'SF-01',
      subFunctionTag: 'T1',
      nfcSerial: '00:removed:chip',
      classId: '7',
      formData: {}
    }

    expect(mapServerEntryToLocal(serverEntry, existing).nfcSerial).toBeUndefined()
  })
})

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

  // Regression: a manually-completed entry (fault-report unlock) was silently relabeled
  // as NFC-scanned after any bundle refresh — e.g. simply reopening a draft sheet while
  // online, which runs this merge again before the operator ever hits final submit.
  // The server never reports filledVia back (no such field on ServerLogSheetEntry), so it
  // must be inherited from the existing local entry whenever local data is preserved.
  it('preserves filledVia="manual" across a bundle refresh', () => {
    const existing: LogSheetEntryData = {
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

    const local = mapServerEntryToLocal(serverEntry, existing)

    expect(local.filledVia).toBe('manual')
  })

  it('drops filledVia when preserveLocal is false (server form data wins)', () => {
    const existing: LogSheetEntryData = {
      assetId: '42',
      assetName: 'Pump A',
      subFunctionCode: 'SF-01',
      subFunctionTag: 'T1',
      classId: '7',
      formData: { temp: 25 },
      filledVia: 'manual'
    }

    const local = mapServerEntryToLocal(serverEntry, existing, false)

    expect(local.filledVia).toBeUndefined()
    expect(local.formData).toEqual({ temp: 10 })
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

  it('preserves filledVia through a full inbox/bundle merge cycle', () => {
    const existing: LogSheetEntryData[] = [
      {
        assetId: '42',
        assetName: 'Pump A',
        subFunctionCode: 'SF-01',
        subFunctionTag: 'T1',
        classId: '7',
        formData: { temp: 30 },
        filledVia: 'manual'
      }
    ]

    const merged = mergeEntriesPreservingFormData([serverEntry], existing)

    expect(merged[0].filledVia).toBe('manual')
  })
})
