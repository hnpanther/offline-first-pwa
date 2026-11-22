import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNCED_RETENTION_HOURS,
  DEFAULT_UNSYNCED_RETENTION_HOURS,
  LEGACY_RETENTION_WINDOWS,
  normalizeDeviceRetention,
  resolveRetentionWindows
} from '@/services/sync/deviceRetention'

/**
 * Backend roadmap §41 — the device half of "how long a round stays on the tablet".
 *
 * Everything here is about values that are wrong. A correct server sends correct numbers; the
 * cases worth pinning are the ones where something between it and the purge — a proxy, an older
 * build, a hand-edited row, a corrupted IndexedDB record — hands this code a value nobody chose.
 * The one outcome that must never come out of any of them is a purge of undelivered readings.
 */

const HOUR = 60 * 60 * 1000

describe('normalizeDeviceRetention — what arrives on bootstrap', () => {
  it('returns nothing when the server sent no block, so the device keeps what it has', () => {
    expect(normalizeDeviceRetention(undefined)).toBeUndefined()
    expect(normalizeDeviceRetention(null)).toBeUndefined()
  })

  it('keeps a well-formed block exactly', () => {
    expect(
      normalizeDeviceRetention({
        syncedRetentionHours: 48,
        unsyncedPurgeEnabled: true,
        unsyncedRetentionHours: 336
      })
    ).toEqual({ syncedRetentionHours: 48, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 336 })
  })

  it('accepts the exact bounds', () => {
    expect(
      normalizeDeviceRetention({ syncedRetentionHours: 1, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 })
    ).toEqual({ syncedRetentionHours: 1, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 })
    expect(
      normalizeDeviceRetention({ syncedRetentionHours: 720, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 8760 })
    ).toEqual({ syncedRetentionHours: 720, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 8760 })
  })

  it('clamps a value above the ceiling down to it', () => {
    const policy = normalizeDeviceRetention({
      syncedRetentionHours: 10_000,
      unsyncedPurgeEnabled: true,
      unsyncedRetentionHours: 1_000_000
    })
    expect(policy?.syncedRetentionHours).toBe(720)
    expect(policy?.unsyncedRetentionHours).toBe(8760)
  })

  it('raises a value below the floor up to it — never shortens an undelivered round below 72 h', () => {
    const policy = normalizeDeviceRetention({
      syncedRetentionHours: 0.2,
      unsyncedPurgeEnabled: true,
      unsyncedRetentionHours: 1
    })
    expect(policy?.syncedRetentionHours).toBe(1)
    expect(policy?.unsyncedRetentionHours).toBe(72)
  })

  it('reads zero, a negative number, NaN, Infinity and text as unreadable — the default, not zero', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '48', null, {}, [], true]) {
      const policy = normalizeDeviceRetention({
        syncedRetentionHours: bad,
        unsyncedPurgeEnabled: true,
        unsyncedRetentionHours: bad
      })
      expect(policy?.syncedRetentionHours, String(bad)).toBe(DEFAULT_SYNCED_RETENTION_HOURS)
      expect(policy?.unsyncedRetentionHours, String(bad)).toBe(DEFAULT_UNSYNCED_RETENTION_HOURS)
    }
  })

  it('switches the purge of undelivered rounds on only for exactly `true`', () => {
    for (const notTrue of ['true', 1, 'yes', {}, null, undefined, false]) {
      expect(
        normalizeDeviceRetention({
          syncedRetentionHours: 24,
          unsyncedPurgeEnabled: notTrue,
          unsyncedRetentionHours: 168
        })?.unsyncedPurgeEnabled,
        String(notTrue)
      ).toBe(false)
    }
  })

  it('reads a block that is not an object as present-but-unreadable: defaults, purge off', () => {
    // A server that sent *something* has a policy; it is just not readable. Falling back to the
    // legacy constants here would purge undelivered rounds after a week on a garbled payload.
    for (const garbled of ['24', 7, true, [24, true, 168]]) {
      expect(normalizeDeviceRetention(garbled), JSON.stringify(garbled)).toEqual({
        syncedRetentionHours: 24,
        unsyncedPurgeEnabled: false,
        unsyncedRetentionHours: 168
      })
    }
  })

  it('reads each field on its own, so one bad value cannot cost the others', () => {
    expect(
      normalizeDeviceRetention({
        syncedRetentionHours: 'soon',
        unsyncedPurgeEnabled: true,
        unsyncedRetentionHours: 96
      })
    ).toEqual({ syncedRetentionHours: 24, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 96 })
  })

  it('rounds a fractional hour rather than carrying it', () => {
    expect(
      normalizeDeviceRetention({ syncedRetentionHours: 36.6, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 100.4 })
    ).toEqual({ syncedRetentionHours: 37, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 100 })
  })
})

describe('resolveRetentionWindows — what the purge runs on', () => {
  it('runs on the shipped constants when no server has ever sent a policy', () => {
    // A newer app against an older server must behave exactly as the app that server shipped
    // with: 24 h synced, 7 days refused, 24 h past the deadline.
    for (const never of [undefined, null]) {
      expect(resolveRetentionWindows(never)).toEqual({
        syncedMs: 24 * HOUR,
        failedMs: 7 * 24 * HOUR,
        expiredDraftMs: 24 * HOUR
      })
    }
    expect(resolveRetentionWindows(undefined)).toEqual(LEGACY_RETENTION_WINDOWS)
  })

  it('hands back a copy of the legacy windows, never the shared constant itself', () => {
    const windows = resolveRetentionWindows(undefined)
    windows.failedMs = null
    expect(LEGACY_RETENTION_WINDOWS.failedMs).toBe(7 * 24 * HOUR)
  })

  it('never purges an undelivered round while the switch is off — the default', () => {
    expect(
      resolveRetentionWindows({ syncedRetentionHours: 24, unsyncedPurgeEnabled: false, unsyncedRetentionHours: 168 })
    ).toEqual({ syncedMs: 24 * HOUR, failedMs: null, expiredDraftMs: null })
  })

  it('uses the one undelivered window for both a refused round and an expired draft when on', () => {
    expect(
      resolveRetentionWindows({ syncedRetentionHours: 6, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 96 })
    ).toEqual({ syncedMs: 6 * HOUR, failedMs: 96 * HOUR, expiredDraftMs: 96 * HOUR })
  })

  it('clamps a stored value again, so a corrupted record cannot shorten anything', () => {
    expect(
      resolveRetentionWindows({ syncedRetentionHours: -1, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 2 })
    ).toEqual({ syncedMs: 24 * HOUR, failedMs: 72 * HOUR, expiredDraftMs: 72 * HOUR })
  })

  it('reads a stored value that is not an object as purge-off, never as the legacy constants', () => {
    expect(resolveRetentionWindows('garbage')).toEqual({
      syncedMs: 24 * HOUR,
      failedMs: null,
      expiredDraftMs: null
    })
  })
})
