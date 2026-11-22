import { describe, expect, it } from 'vitest'
import { COMBOBOX_POPPER_STRATEGY, showLookupAvailabilityHint } from './comboboxLayout'

describe('lookup availability hint', () => {
  it('stays hidden until the lease read answers, and while the list is ready', () => {
    expect(showLookupAvailabilityHint('pending')).toBe(false)
    expect(showLookupAvailabilityHint('ready')).toBe(false)
  })

  it('shows once the copy is actually missing, unfinished, or expired', () => {
    expect(showLookupAvailabilityHint('absent')).toBe(true)
    expect(showLookupAvailabilityHint('syncing')).toBe(true)
    expect(showLookupAvailabilityHint('expired')).toBe(true)
  })
})

describe('combobox popper', () => {
  it('does not use absolute positioning, which lengthens a window-scrolled page', () => {
    expect(COMBOBOX_POPPER_STRATEGY).toBe('fixed')
  })
})
