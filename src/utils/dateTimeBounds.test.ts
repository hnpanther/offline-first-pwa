import { describe, expect, it } from 'vitest'
import { dateTimeBoundsError } from './dateTimeBounds'
const now = 1800000000000
const rules = {
  dateTimeRange: { min: now - 120000, max: now + 120000 },
  dateTimeRelative: { beforeMinutes: 1, afterMinutes: 1 }
}
describe('date-time bounds', () => {
  it('uses inclusive boundaries and both restrictions', () => {
    expect(dateTimeBoundsError(now - 60000, rules, now)).toBeUndefined()
    expect(dateTimeBoundsError(now + 60000, rules, now)).toBeUndefined()
    expect(dateTimeBoundsError(now - 60001, rules, now)).toBeTruthy()
    expect(dateTimeBoundsError(now + 120001, rules, now)).toBeTruthy()
  })
  it('allows absent limits and zero-minute boundaries, refuses malformed values', () => {
    expect(dateTimeBoundsError(now, {}, now)).toBeUndefined()
    expect(dateTimeBoundsError(now, { dateTimeRelative: { beforeMinutes: 0, afterMinutes: 0 } }, now)).toBeUndefined()
    expect(dateTimeBoundsError('bad', rules, now)).toBeTruthy()
  })
})
