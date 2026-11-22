import { describe, expect, it } from 'vitest'
import { offlineFormFillBlocked } from './formFillGate'

describe('offline form fill gate', () => {
  const personnel = [{ code: 'STAFF' }]

  it('blocks offline fill until this form’s lists are on the device', () => {
    expect(
      offlineFormFillBlocked({
        requiredLookups: personnel,
        completeCodes: [],
        offline: true
      })
    ).toBe(true)
    expect(
      offlineFormFillBlocked({
        requiredLookups: personnel,
        completeCodes: ['staff'],
        offline: true
      })
    ).toBe(false)
  })

  it('does not block a form with no lists, and does not block while online', () => {
    expect(
      offlineFormFillBlocked({ requiredLookups: [], completeCodes: [], offline: true })
    ).toBe(false)
    expect(
      offlineFormFillBlocked({
        requiredLookups: personnel,
        completeCodes: [],
        offline: false
      })
    ).toBe(false)
  })
})
