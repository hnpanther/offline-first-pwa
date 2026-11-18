/**
 * How often a signed-in tablet asks the server about its own device (backend V28).
 *
 * A revoke reaches a tablet through its session — the next request answers 401 — but only a
 * session that is **tied to the device**, which is one opened while device enrolment was on. A
 * session opened while it was off carries no device id on the server; the revoke cannot end it,
 * and before this the tablet learnt of a wipe order only at its next sign-in, up to a token's
 * lifetime (8 hours by default) later. So while a session is open and the server reachable, the
 * tablet asks `/api/auth/challenge` itself — at most once per {@link DEVICE_STATUS_CHECK_INTERVAL_MS},
 * counted across restarts — and acts on the answer (`checkDeviceStatus` in `deviceWipe.ts`).
 *
 * The throttle is on the device clock, deliberately: it only spaces requests out, and a clock set
 * back reads as «due», so the worst a wrong clock can do is one extra request.
 */

import { db } from '@/services/storage/db'

/** At most this often; a revoke or wipe order reaches an online, signed-in tablet within it. */
export const DEVICE_STATUS_CHECK_INTERVAL_MS = 30 * 60 * 1000

const CHECKED_META_KEY = 'deviceStatusCheckedAt'

/** Whether a check is due: never asked, the interval passed, or the clock went back since. */
export function isDeviceStatusCheckDue(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt == null || !Number.isFinite(lastCheckedAt)) return true
  if (now < lastCheckedAt) return true
  return now - lastCheckedAt >= DEVICE_STATUS_CHECK_INTERVAL_MS
}

export async function lastDeviceStatusCheck(): Promise<number | null> {
  try {
    const row = await db.syncMeta.get(CHECKED_META_KEY)
    return typeof row?.value === 'number' ? row.value : null
  } catch {
    return null
  }
}

export async function recordDeviceStatusCheck(now: number = Date.now()): Promise<void> {
  try {
    await db.syncMeta.put({ key: CHECKED_META_KEY, value: now })
  } catch {
    /* the next check simply comes sooner */
  }
}
