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

describe('blank local formData must not beat the server', () => {
  // The defect this whole block exists for. The web fill form used to post every field of every
  // entry on every save, so an asset nobody had opened arrived as {"Bar": "", "Status": ""}.
  // `mapServerEntryToLocal` then asked `Object.keys(localForm).length > 0` — key presence, not
  // value presence — which was true forever after. `localWins` collapsed into `preserveLocal`,
  // the server side of the merge stopped existing, and an operator handed a reopened sheet could
  // not see the readings a supervisor had just entered. Their next submit sent the blanks back.
  // Log sheet 85.
  const base = (formData: Record<string, unknown>): LogSheetEntryData => ({
    assetId: '42',
    assetName: 'Pump A',
    subFunctionCode: 'SF-01',
    subFunctionTag: 'T1',
    classId: '7',
    formData
  })

  it('takes the server values when the local copy holds only blank keys', () => {
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6', Status: 'ON' }, filledByName: 'سرپرست' },
      base({ Bar: '', Status: '' }),
      true
    )

    expect(local.formData).toEqual({ Bar: '6', Status: 'ON' })
    // Attribution follows the values, so the operator sees whose reading they are looking at.
    expect(local.filledByName).toBe('سرپرست')
  })

  it('takes the server values when the local copy holds only whitespace', () => {
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' } },
      base({ Bar: '   ' }),
      true
    )

    expect(local.formData).toEqual({ Bar: '6' })
  })

  it('takes the server values when the local copy holds an emptied attachment field', () => {
    // A non-empty object that means "nothing attached" — the case a `typeof value === object`
    // check gets wrong in the opposite direction from a blank string.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Pic: { type: 'attachment', ids: ['a7f3'] } } },
      base({ Pic: { type: 'attachment', ids: [] } }),
      true
    )

    expect(local.formData).toEqual({ Pic: { type: 'attachment', ids: ['a7f3'] } })
  })

  it('still lets a real local reading win over the server', () => {
    // The behaviour that must NOT change: unsent work on this device is not discarded by a
    // bundle refresh. Fixing the blank case by making the server always win would be a worse
    // bug than the one being fixed.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' }, filledByName: 'سرپرست' },
      base({ Bar: '9' }),
      true
    )

    expect(local.formData).toEqual({ Bar: '9' })
    expect(local.filledByName).toBeUndefined()
  })

  it('treats a reading of zero as a real local answer', () => {
    // In a plant a zero is usually the interesting reading. A falsy check here would throw it
    // away and replace it with whatever the server last had.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' } },
      base({ Bar: 0 }),
      true
    )

    expect(local.formData).toEqual({ Bar: 0 })
  })

  it('keeps the previous operator name on an untouched local draft', () => {
    // A local draft that is still the previous operator's work must go on naming them; it is
    // the save that clears the name, not the merge.
    const existing = { ...base({ Bar: '9' }), filledByName: 'اپراتور یک' }

    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' }, filledByName: 'سرپرست' },
      existing,
      true
    )

    expect(local.filledByName).toBe('اپراتور یک')
  })

  it('applies across a whole bundle: blanks refreshed, real answers kept', () => {
    // The reopened-sheet handover in one assertion. Asset 42 is the operator's own reading;
    // asset 43 is the one the supervisor answered in the browser while this device was away.
    const merged = mergeEntriesPreservingFormData(
      [
        { ...serverEntry, assetId: 42, formData: { Bar: '7' } },
        { ...serverEntry, assetId: 43, formData: { Bar: '6', Status: 'ON' } }
      ],
      [
        { ...base({ Bar: '7' }), assetId: '42' },
        { ...base({ Bar: '', Status: '' }), assetId: '43' }
      ],
      { preserveLocal: true }
    )

    expect(merged.map(e => e.formData)).toEqual([
      { Bar: '7' },
      { Bar: '6', Status: 'ON' }
    ])
  })
})

describe('a deliberate clear is an opinion, and it must survive a bundle refresh', () => {
  // The counterpart to the block above, and the failure mode the fix for it introduced.
  // `hasEntryFormData` alone reads "the operator emptied this on purpose" as "this device holds
  // nothing", so the next periodic sync wrote the old server value back and the deletion was
  // gone before the operator ever reached submit. Neither key presence nor value presence can
  // answer "does this device have an opinion here?" — so the save records it: `locallyEditedAt`.
  const CLEAR_AT = 1_700_000_900_000

  const cleared = (overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData => ({
    assetId: '42',
    assetName: 'Pump A',
    subFunctionCode: 'SF-01',
    subFunctionTag: 'T1',
    classId: '7',
    // What the fill form actually saves: every registered key, all blank. The timestamps are
    // untouched by an empty save, and stay the base this device last saw.
    formData: { Bar: '', Status: '' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_050_000,
    locallyEditedAt: CLEAR_AT,
    ...overrides
  })

  it("keeps the operator’s empty entry instead of restoring the server value", () => {
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7', Status: 'OFF' } },
      cleared(),
      true
    )

    expect(local.formData).toEqual({ Bar: '', Status: '' })
    expect(local.locallyEditedAt).toBe(CLEAR_AT)
  })

  it('keeps the base timestamps with it, so the server still recognises the clear', () => {
    // These two are echoed back on submit and read by the server's `wouldBlankUnseenAnswer` as
    // "the version this device last saw". A clear whose base matches is allowed through; one
    // that has drifted is refused. Losing them here would make every clear look stale.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7' } },
      cleared(),
      true
    )

    expect(local.createdAt).toBe(1_700_000_000_000)
    expect(local.updatedAt).toBe(1_700_000_050_000)
  })

  it('does not keep a blank entry the operator never touched', () => {
    // No marker: this is the contaminated shape the web form used to write onto assets nobody
    // opened. It must lose, or log sheet 85 comes back.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7', Status: 'OFF' } },
      cleared({ locallyEditedAt: undefined }),
      true
    )

    expect(local.formData).toEqual({ Bar: '7', Status: 'OFF' })
  })

  it('stops honouring the marker once the work has been delivered', () => {
    // `localEditsPending: false` is the row being `submitted` + `synced`. Everything it holds
    // came from the server, so a marker still standing describes an opinion that no longer
    // exists — and honouring it would hand this device the entry on every future merge, which
    // is precisely how a supervisor's later edits would go invisible.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7', Status: 'OFF' } },
      cleared(),
      true,
      false
    )

    expect(local.formData).toEqual({ Bar: '7', Status: 'OFF' })
    expect(local.locallyEditedAt).toBeUndefined()
  })

  it("ignores the marker entirely when the local work is not this session’s", () => {
    // preserveLocal false means the row belongs to somebody else; a marker cannot override that.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7' } },
      cleared(),
      false
    )

    expect(local.formData).toEqual({ Bar: '7' })
    expect(local.locallyEditedAt).toBeUndefined()
  })

  it('drops the marker when the server wins, so it cannot resurrect later', () => {
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '7' } },
      cleared({ locallyEditedAt: undefined }),
      true
    )

    expect(local.locallyEditedAt).toBeUndefined()
  })
})

describe('timestamps follow whichever side won the values', () => {
  const base = (overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData => ({
    assetId: '42',
    assetName: 'Pump A',
    subFunctionCode: 'SF-01',
    subFunctionTag: 'T1',
    classId: '7',
    formData: {},
    ...overrides
  })

  it('takes the server timestamps when the server wins the values', () => {
    // They used to follow `preserveLocal`, so a device could end up displaying the server's
    // values while telling the server it was working from a base it had never held — which then
    // made the server refuse a legitimate clear on that entry.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' }, createdAt: 5_000, updatedAt: 9_999 },
      base({ formData: { Bar: '', Status: '' }, createdAt: 1_000, updatedAt: 2_000 }),
      true
    )

    expect(local.formData).toEqual({ Bar: '6' })
    expect(local.createdAt).toBe(5_000)
    expect(local.updatedAt).toBe(9_999)
  })

  it('keeps the local timestamps when the local values win', () => {
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' }, createdAt: 5_000, updatedAt: 9_999 },
      base({ formData: { Bar: '9' }, createdAt: 1_000, updatedAt: 2_000 }),
      true
    )

    expect(local.formData).toEqual({ Bar: '9' })
    expect(local.createdAt).toBe(1_000)
    expect(local.updatedAt).toBe(2_000)
  })

  it('inherits the server timestamps for an entry this device has never held data for', () => {
    // The ?? fallbacks: a local row with no timestamps takes the server's, which is what makes
    // an untouched entry echo the right base back on submit.
    const local = mapServerEntryToLocal(
      { ...serverEntry, formData: { Bar: '6' }, createdAt: 5_000, updatedAt: 9_999 },
      base(),
      true
    )

    expect(local.createdAt).toBe(5_000)
    expect(local.updatedAt).toBe(9_999)
  })
})
