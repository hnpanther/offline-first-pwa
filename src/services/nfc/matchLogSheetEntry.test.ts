import { describe, it, expect } from 'vitest'
import { matchLogSheetEntryByTag } from './matchLogSheetEntry'
import type { LogSheetEntryData } from '@/types'

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '1',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    nfcTagId: 'ID:2455',
    classId: '7',
    formData: {},
    ...overrides
  }
}

const sheet = [
  entry({ assetId: '1', nfcTagId: 'ID:2455', nfcSerial: '04:33:26:92:D0:12:91' }),
  entry({ assetId: '2', nfcTagId: 'ID:99', nfcSerial: undefined })
]

describe('default mode — Record 1 only (must stay exactly as it was)', () => {
  it('matches on the tag id alone', () => {
    const r = matchLogSheetEntryByTag(sheet, 'ID:2455')
    expect(r.kind).toBe('matched')
    expect(r.kind === 'matched' && r.entry.assetId).toBe('1')
  })

  it('ignores the scanned serial entirely, even a wrong one', () => {
    const r = matchLogSheetEntryByTag(sheet, 'ID:2455', { scannedSerial: 'ff:ff:ff:ff' })
    expect(r.kind).toBe('matched')
  })

  it('matches an asset that has no serial recorded', () => {
    expect(matchLogSheetEntryByTag(sheet, 'ID:99').kind).toBe('matched')
  })

  it('tolerates surrounding whitespace on the scanned tag id', () => {
    expect(matchLogSheetEntryByTag(sheet, '  ID:2455  ').kind).toBe('matched')
  })

  it('reports a tag that belongs to no asset in this sheet', () => {
    expect(matchLogSheetEntryByTag(sheet, 'ID:0').kind).toBe('notInSheet')
  })

  it('treats an empty tag id as no match', () => {
    expect(matchLogSheetEntryByTag(sheet, '   ').kind).toBe('notInSheet')
  })
})

describe('strict mode — Record 1 AND serial', () => {
  const strict = { strictSerial: true }

  it('matches when both the tag id and the serial agree', () => {
    const r = matchLogSheetEntryByTag(sheet, 'ID:2455', {
      ...strict,
      scannedSerial: '04:33:26:92:D0:12:91'
    })
    expect(r.kind).toBe('matched')
  })

  it('compares serials case-insensitively and ignoring separators', () => {
    for (const scanned of ['04:33:26:92:d0:12:91', '04-33-26-92-D0-12-91', '04332692d01291']) {
      expect(matchLogSheetEntryByTag(sheet, 'ID:2455', { ...strict, scannedSerial: scanned }).kind)
        .toBe('matched')
    }
  })

  it('rejects a different physical chip carrying the right payload', () => {
    const r = matchLogSheetEntryByTag(sheet, 'ID:2455', {
      ...strict,
      scannedSerial: '04:00:00:00:00:00:00'
    })
    expect(r.kind).toBe('serialMismatch')
  })

  it('rejects when the reader gave no serial at all', () => {
    expect(matchLogSheetEntryByTag(sheet, 'ID:2455', strict).kind).toBe('serialMismatch')
    expect(matchLogSheetEntryByTag(sheet, 'ID:2455', { ...strict, scannedSerial: '  ' }).kind)
      .toBe('serialMismatch')
  })

  it('rejects — rather than falls back — when the asset has no serial recorded', () => {
    const r = matchLogSheetEntryByTag(sheet, 'ID:99', { ...strict, scannedSerial: 'aa:bb' })
    expect(r.kind).toBe('serialMissing')
  })

  it('still reports an unknown tag as not-in-sheet, not as a serial problem', () => {
    expect(matchLogSheetEntryByTag(sheet, 'ID:0', { ...strict, scannedSerial: 'aa' }).kind)
      .toBe('notInSheet')
  })
})
