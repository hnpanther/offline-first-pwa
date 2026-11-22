import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import {
  DEVICE_STATUS_CHECK_INTERVAL_MS,
  isDeviceStatusCheckDue,
  lastDeviceStatusCheck,
  recordDeviceStatusCheck
} from './deviceStatusWatch'

/**
 * Backend V28 — how often a signed-in tablet asks about its own device. The interval is what an
 * administrator is told («حداکثر نیم ساعت»), so it is pinned, and so is the rule that a clock set
 * back reads as due rather than silencing the check.
 */

const T = 1_800_000_000_000

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.syncMeta.clear()
})

describe('the device-status check throttle', () => {
  it('is half an hour — the wording in the panel depends on it', () => {
    expect(DEVICE_STATUS_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000)
  })

  it('is due when never asked, when the interval has passed, and when the clock went back', () => {
    expect(isDeviceStatusCheckDue(null, T)).toBe(true)
    expect(isDeviceStatusCheckDue(T, T + DEVICE_STATUS_CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(isDeviceStatusCheckDue(T, T + DEVICE_STATUS_CHECK_INTERVAL_MS)).toBe(true)
    expect(isDeviceStatusCheckDue(T, T - 1)).toBe(true)
    expect(isDeviceStatusCheckDue(Number.NaN, T)).toBe(true)
  })

  it('remembers the last check across restarts', async () => {
    expect(await lastDeviceStatusCheck()).toBeNull()
    await recordDeviceStatusCheck(T)
    expect(await lastDeviceStatusCheck()).toBe(T)
  })
})
