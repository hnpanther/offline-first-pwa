import { describe, expect, it } from 'vitest'
import {
  canonicalDateTime,
  isDateTimeDataType,
  isUsableDateTime,
  parseDateTimeEpoch,
  toDateTimeValue
} from './dateTimeValue'

describe('dateTimeValue', () => {
  it('recognises the data type case-insensitively', () => {
    expect(isDateTimeDataType('datetime')).toBe(true)
    expect(isDateTimeDataType('DateTime')).toBe(true)
    expect(isDateTimeDataType('date')).toBe(false)
  })

  it('parses the canonical object, a bare epoch, and digit strings', () => {
    const epoch = 1_732_420_200_000
    expect(parseDateTimeEpoch({ type: 'datetime', epochMs: epoch })).toBe(epoch)
    expect(parseDateTimeEpoch(epoch)).toBe(epoch)
    expect(parseDateTimeEpoch(String(epoch))).toBe(epoch)
  })

  it('rejects out-of-range and junk', () => {
    expect(parseDateTimeEpoch(-1)).toBeNull()
    expect(parseDateTimeEpoch({ type: 'datetime' })).toBeNull()
    expect(parseDateTimeEpoch('not-a-date')).toBeNull()
    expect(parseDateTimeEpoch(null)).toBeNull()
  })

  it('canonicalises to the typed object', () => {
    const epoch = 1_732_420_200_000
    expect(canonicalDateTime(epoch)).toEqual(toDateTimeValue(epoch))
    expect(isUsableDateTime(canonicalDateTime(epoch))).toBe(true)
    expect(isUsableDateTime(undefined)).toBe(false)
  })
})
