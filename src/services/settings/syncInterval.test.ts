import { describe, it, expect } from 'vitest'
import {
  clampSyncInterval,
  fromSeconds,
  toSeconds,
  DEFAULT_SYNC_INTERVAL_MS,
  MIN_SYNC_INTERVAL_MS,
  MAX_SYNC_INTERVAL_MS
} from './syncInterval'

/**
 * The interval is stored in milliseconds and shown in seconds, and the bug these tests exist
 * for was converting between them twice: the form's field converted on the way in and out, and
 * the submit handler converted again, so *every save multiplied the stored value by 1000* —
 * including a save where nobody touched the field.
 */
describe('sync interval conversion', () => {
  it('round-trips a value through the seconds box unchanged', () => {
    // This is the property the double conversion broke. Opening Settings and pressing Save
    // without touching anything must leave the interval exactly as it was.
    expect(clampSyncInterval(fromSeconds(toSeconds(30_000)))).toBe(30_000)
    expect(clampSyncInterval(fromSeconds(toSeconds(60_000)))).toBe(60_000)
  })

  it('does not drift when the form is saved repeatedly', () => {
    let stored = 30_000
    for (let i = 0; i < 5; i++) {
      // Exactly what the page does: display, then hand the form value back to the store.
      stored = clampSyncInterval(fromSeconds(toSeconds(stored)))
    }
    expect(stored).toBe(30_000)
  })

  it('shows milliseconds as seconds', () => {
    expect(toSeconds(30_000)).toBe(30)
    expect(toSeconds(3_600_000)).toBe(3600)
  })

  it('falls back to the default rather than showing a nonsense number', () => {
    // A settings row written before this field existed, or corrupted on the device.
    expect(toSeconds(undefined)).toBe(30)
    expect(toSeconds(0)).toBe(30)
    expect(toSeconds('nonsense')).toBe(30)
  })

  it('refuses a zero interval instead of storing a sync loop with no delay', () => {
    // `<input type="number">` hands back '' for an empty box, and Number('') is 0. Storing
    // that would make the device sync continuously against the server.
    expect(clampSyncInterval(fromSeconds(''))).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(clampSyncInterval(0)).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(clampSyncInterval(-5_000)).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(clampSyncInterval(NaN)).toBe(DEFAULT_SYNC_INTERVAL_MS)
  })

  it('clamps to the supported range, because the input min/max are only a hint', () => {
    // The form carries noValidate, so the browser never enforces them.
    expect(clampSyncInterval(fromSeconds(1))).toBe(MIN_SYNC_INTERVAL_MS)
    expect(clampSyncInterval(fromSeconds(99_999))).toBe(MAX_SYNC_INTERVAL_MS)
    // And the old bug's own output is now caught rather than stored.
    expect(clampSyncInterval(30_000 * 1000)).toBe(MAX_SYNC_INTERVAL_MS)
  })

  it('keeps a value the operator deliberately typed', () => {
    expect(clampSyncInterval(fromSeconds(45))).toBe(45_000)
    expect(clampSyncInterval(fromSeconds(600))).toBe(600_000)
  })
})
