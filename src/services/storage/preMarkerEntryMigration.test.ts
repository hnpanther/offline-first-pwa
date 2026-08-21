import { describe, expect, it } from 'vitest'
import { markPreMarkerEntriesAsLocal } from './db'
import type { LogSheetEntryData } from '@/types'

/**
 * The `version(2)` migration: entries that hold work but predate `locallyEditedAt`.
 *
 * <h2>Why it exists</h2>
 *
 * The merge now decides ownership only by the marker, because no question about `formData` can
 * separate a reading the operator typed from one the server sent. That leaves entries written by
 * builds before the marker existed: they hold real, unsent work and carry no proof of it, so
 * under the new rule the server would win them and the operator's reading would be replaced on
 * the next sync.
 *
 * <p>Stamping them once, at upgrade, keeps the old behaviour for exactly as long as those rows
 * exist — until each sheet is submitted and its markers are cleared. The alternative was leaving
 * `|| hasEntryFormData(...)` in the merge, which is the smaller diff and the worse answer: an OR
 * arm that only matters for old rows still runs on every merge forever, and carries the bug with
 * it, to protect rows that stop existing after the first submit.
 *
 * <h2>Why the scope is narrow</h2>
 *
 * A marker asserts "this device has an opinion here", and a wrong one is not a harmless
 * over-approximation: it hands the device that entry on every future merge, which is how a
 * supervisor's later edits go invisible (log sheet 85). So this stamps only what could plausibly
 * be unsent work.
 */

const NOW = 1_700_000_000_000

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '7',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '2',
    formData: { temp: 42 },
    ...overrides
  }
}

function sheet(entries: LogSheetEntryData[], overrides: Record<string, unknown> = {}) {
  return { status: 'draft', syncStatus: 'pending', entries, ...overrides }
}

describe('what gets a marker', () => {
  it('stamps an entry that holds work and has none', () => {
    const s = sheet([entry()])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('stamps a reading of zero, which is a real answer in a plant', () => {
    const s = sheet([entry({ formData: { temp: 0 } })])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('stamps every entry of the sheet that qualifies, not just the first', () => {
    const s = sheet([
      entry({ assetId: '1' }),
      entry({ assetId: '2', formData: {} }),
      entry({ assetId: '3', formData: { temp: 9 } })
    ])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries.map(e => e.locallyEditedAt)).toEqual([NOW, undefined, NOW])
  })
})

describe('what must not get one', () => {
  it('leaves an empty entry alone', () => {
    // Nobody filled it. A marker here would make the device win an entry it knows nothing
    // about, and the server could never fill it again.
    const s = sheet([entry({ formData: {} })])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('leaves an entry holding only blank keys alone', () => {
    // The shape the old web fill form wrote onto every asset of a sheet, including ones nobody
    // opened. Treating it as work is log sheet 85 exactly.
    const s = sheet([entry({ formData: { Bar: '', Status: '   ' } })])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('leaves an emptied attachment field alone', () => {
    // A non-empty object meaning "nothing attached" — the case a `typeof value === object`
    // check gets wrong in the opposite direction from a blank string.
    const s = sheet([entry({ formData: { Pic: { type: 'attachment', ids: [] } } })])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('leaves a delivered sheet entirely alone', () => {
    // `submitted` + `synced`: everything it holds came back from the server, so there is no
    // local opinion to preserve — and a marker here would hand the device every future merge on
    // a sheet a supervisor is about to reopen and edit.
    const s = sheet([entry()], { status: 'submitted', syncStatus: 'synced' })

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('does stamp an unsent completion, which has not been delivered', () => {
    // `submitted` + `pending` is work waiting in the outbound queue. It is still this device's.
    const s = sheet([entry()], { status: 'submitted', syncStatus: 'pending' })

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBe(NOW)
  })

  it('does not overwrite a marker that is already there', () => {
    // The original timestamp is the honest one; this migration knows only "before now".
    const s = sheet([entry({ locallyEditedAt: 1_600_000_000_000 })])

    markPreMarkerEntriesAsLocal(s, NOW)

    expect(s.entries[0].locallyEditedAt).toBe(1_600_000_000_000)
  })
})

describe('running it on rows it cannot understand', () => {
  it('survives a sheet with no entries array', () => {
    // Dexie hands back whatever is on disk, and an upgrade that throws leaves the database
    // unopenable on a device holding unsynced work.
    expect(() => markPreMarkerEntriesAsLocal({ status: 'draft' })).not.toThrow()
    expect(() => markPreMarkerEntriesAsLocal({ entries: undefined })).not.toThrow()
    expect(() => markPreMarkerEntriesAsLocal({ entries: null as never })).not.toThrow()
  })

  it('survives an entry with no formData', () => {
    const s = sheet([{ assetId: '7' } as LogSheetEntryData])

    expect(() => markPreMarkerEntriesAsLocal(s, NOW)).not.toThrow()
    expect(s.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('is idempotent, so an interrupted upgrade can simply run again', () => {
    const s = sheet([entry()])

    markPreMarkerEntriesAsLocal(s, NOW)
    markPreMarkerEntriesAsLocal(s, NOW + 5_000)

    expect(s.entries[0].locallyEditedAt).toBe(NOW)
  })
})
