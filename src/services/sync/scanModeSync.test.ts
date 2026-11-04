import { describe, expect, it } from 'vitest'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import type { LogSheet, LogSheetEntryData } from '@/types'

/**
 * How a reading says which channel captured it, and how a round says which channel it requires.
 *
 * <h3>Two fields on the way up, not one</h3>
 *
 * `manualEntry` is the boolean every server since the beginning reads. `entrySource` is the
 * field a current server prefers, and the only one that can distinguish a QR scan from a tag
 * scan — a boolean cannot. Both go, so a tablet talking to an older server is labelled exactly
 * as it always was, and one talking to a current server is labelled precisely.
 *
 * <h3>Why the distinction is worth carrying at all</h3>
 *
 * A chip read can be checked against a hardware serial; a QR code is a printed string with no
 * hardware behind it. Merging them into one «scanned» would have a report overstate what half
 * its rows prove.
 */

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '42',
    assetName: 'Pump',
    subFunctionCode: 'SF',
    subFunctionTag: 'T',
    classId: '7',
    formData: { temp: 22 },
    ...overrides
  }
}

function sheet(entries: LogSheetEntryData[], overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: '99',
    templateId: '5',
    templateName: 'Daily',
    scopeSummary: 'loc:1',
    status: 'submitted',
    syncStatus: 'pending',
    clientActionId: 'action-1',
    completedAt: 1_700_000_200_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
    entries,
    ...overrides
  }
}

describe('the channel a reading reports', () => {
  it('sends PWA_QR beside manualEntry=false for a QR read', () => {
    const payload = toBatchPayload(sheet([entry({ filledVia: 'qr' })]))

    expect(payload.entries?.[0].entrySource).toBe('PWA_QR')
    // The boolean still goes, and still says "not typed by hand" — which is true of a QR read.
    // An older server reads only this and labels it a scan, which is the closest thing it can
    // say. Dropping it would make that server label the reading as manual instead.
    expect(payload.entries?.[0].manualEntry).toBe(false)
  })

  it('sends PWA_NFC for a tag read', () => {
    const payload = toBatchPayload(sheet([entry({ filledVia: 'nfc' })]))

    expect(payload.entries?.[0].entrySource).toBe('PWA_NFC')
    expect(payload.entries?.[0].manualEntry).toBe(false)
  })

  it('sends PWA_MANUAL for a typed or picked entry', () => {
    const payload = toBatchPayload(sheet([entry({ filledVia: 'manual' })]))

    expect(payload.entries?.[0].entrySource).toBe('PWA_MANUAL')
    expect(payload.entries?.[0].manualEntry).toBe(true)
  })

  it('sends neither field for an entry nobody has filled', () => {
    const payload = toBatchPayload(sheet([entry()]))

    // Absent means "this device has nothing to say about how it was captured", which the server
    // reads as the channel that existed before the field did. Sending a guess instead would
    // attribute a reading to a scan that never happened.
    expect(payload.entries?.[0].entrySource).toBeUndefined()
    expect(payload.entries?.[0].manualEntry).toBeUndefined()
  })

  it('labels each entry on its own', () => {
    const payload = toBatchPayload(
      sheet([
        entry({ assetId: '1', filledVia: 'nfc' }),
        entry({ assetId: '2', filledVia: 'qr' }),
        entry({ assetId: '3', filledVia: 'manual' })
      ])
    )

    // One round can mix them: a position whose chip failed is read by its sticker, and one with
    // an approved fault report is typed. The round's mode says what is ALLOWED, never what
    // happened at each asset.
    expect(payload.entries?.map(e => e.entrySource)).toEqual([
      'PWA_NFC',
      'PWA_QR',
      'PWA_MANUAL'
    ])
  })
})
