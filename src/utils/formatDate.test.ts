import { describe, expect, it } from 'vitest'
import { formatJalaliDateTime } from '@/utils/formatDate'

describe('formatJalaliDateTime', () => {
  it('returns dash for missing value', () => {
    expect(formatJalaliDateTime()).toBe('—')
    expect(formatJalaliDateTime(null)).toBe('—')
  })

  it('formats epoch millis in Persian locale', () => {
    const formatted = formatJalaliDateTime(1_700_000_000_000)
    expect(formatted).not.toBe('—')
    expect(formatted.length).toBeGreaterThan(5)
  })
})
