/**
 * How long a signed-in session may keep working without reaching the server — backend V28.
 *
 * <h2>Why</h2>
 *
 * A session that cannot reach the server never expires on this device: offline, `isSessionValid`
 * keeps it on purpose, so an operator in a dead zone is not thrown out mid-round. The cost is that a
 * tablet taken away — stolen, left in a locker, carried off site — opens weeks later still signed in,
 * showing every round and reading on it. This puts a ceiling on that, set by the plant in the panel's
 * «تنظیمات» and delivered on bootstrap as `offlineSession`.
 *
 * <h2>The rule</h2>
 *
 * The session locks once **the server has not answered it for `hours`**, counted from the last
 * authenticated answer, on the server's clock as this device last measured it. It also locks when
 * the device clock reads **earlier** than that last answer by more than {@link CLOCK_SKEW_MS}: time
 * does not run backwards, so a clock set back is either a flat battery or somebody stretching the
 * ceiling, and both are answered the same way — the same rule as the reference-list lease.
 *
 * <h2>What a lock is</h2>
 *
 * The ordinary sign-out: the session, the inbox snapshot and the reference lists go; **every round,
 * reading, photo and unsent submission stays**, and is sent after the next sign-in. Signing in needs
 * the network, which is the point. Nothing here deletes work.
 *
 * <h2>What a lock never interrupts</h2>
 *
 * An open asset form. Values typed and not yet saved live only in memory, and a navigation would
 * discard them — so while the fill page is open the timer and the return-to-app checks hold the lock
 * back, and it lands at the next navigation or the next start. See `useOfflineSessionGuard`.
 *
 * <h2>Off by default</h2>
 *
 * Seeded off, and a device that has never received the block never locks: a value nobody chose must
 * not stop an operator working.
 */

import { db } from '@/services/storage/db'
import { rawServerNow, serverNow } from '@/services/clock/serverClock'
import type { OfflineSessionPolicy } from '@/types'

const HOUR_MS = 60 * 60 * 1000

/** The server's bounds (`AppSettingsService`). Kept in step by hand; both ends clamp. */
export const OFFLINE_SESSION_HOURS_BOUNDS = { min: 8, max: 720 } as const
export const DEFAULT_OFFLINE_SESSION_HOURS = 72

/** A clock this far behind the last answer still counts as right — clocks drift. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000

/** Within this of the lock, the app says so — or within a quarter of the ceiling, if that is less. */
export const WARNING_WINDOW_MS = 12 * HOUR_MS

const CONTACT_META_KEY = 'sessionLastContactAt'
/** A contact is written at most this often: every sync request answers, and each would be a write. */
const PERSIST_EVERY_MS = 60_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the bootstrap block into a policy that is safe to store and act on. `undefined` only when
 * there is no block at all (an older server) — the caller then keeps what the device has.
 */
export function normalizeOfflineSessionLimit(raw: unknown): OfflineSessionPolicy | undefined {
  if (raw === undefined || raw === null) return undefined
  const block = isPlainObject(raw) ? raw : {}
  const hours = block.limitHours ?? block.hours
  return {
    // Exactly `true`, never truthy: "true", 1 or a missing field must not lock anybody out.
    enabled: (block.limitEnabled ?? block.enabled) === true,
    hours:
      typeof hours === 'number' && Number.isFinite(hours) && hours > 0
        ? Math.min(OFFLINE_SESSION_HOURS_BOUNDS.max, Math.max(OFFLINE_SESSION_HOURS_BOUNDS.min, Math.round(hours)))
        : DEFAULT_OFFLINE_SESSION_HOURS
  }
}

// =============================================================================================
// The verdict — pure
// =============================================================================================

export interface OfflineSessionVerdict {
  locked: boolean
  /** `limit`: too long without the server. `clock`: the device clock reads before the last answer. */
  reason?: 'limit' | 'clock'
  /** Server time at which the session locks, when a ceiling applies. */
  lockAt?: number
  /** How long until then; 0 once locked. */
  remainingMs?: number
  /** Whether the app should say the lock is near. */
  warn?: boolean
}

/**
 * Whether this session must lock now.
 *
 * @param policy      what the server set; `undefined` or off never locks
 * @param lastContact server time of the last authenticated answer; `null` (never recorded) never
 *                    locks — the caller records «now» instead
 * @param rawNow      `rawServerNow()` — the device clock corrected by the measured offset and
 *                    **without** the floor, which would hide a clock set back
 */
export function evaluateOfflineSession(
  policy: OfflineSessionPolicy | undefined,
  lastContact: number | null,
  rawNow: number
): OfflineSessionVerdict {
  const limit = normalizeOfflineSessionLimit(policy)
  if (!limit?.enabled || lastContact == null || !Number.isFinite(lastContact)) return { locked: false }

  const lockAt = lastContact + limit.hours * HOUR_MS
  if (rawNow < lastContact - CLOCK_SKEW_MS) {
    return { locked: true, reason: 'clock', lockAt, remainingMs: 0 }
  }
  if (rawNow >= lockAt) {
    return { locked: true, reason: 'limit', lockAt, remainingMs: 0 }
  }
  const remainingMs = lockAt - rawNow
  const warnWindow = Math.min(WARNING_WINDOW_MS, (limit.hours * HOUR_MS) / 4)
  return { locked: false, lockAt, remainingMs, warn: remainingMs <= warnWindow }
}

// =============================================================================================
// The last answer from the server
// =============================================================================================

let lastContact: number | null = null
let lastPersistedAt = Number.NEGATIVE_INFINITY

async function persistContact(value: number): Promise<void> {
  try {
    await db.syncMeta.put({ key: CONTACT_META_KEY, value })
  } catch (err) {
    console.warn('[offline-session] could not record the last server contact', err)
  }
}

/** Server time of the last authenticated answer, or `null` when none is recorded. */
export function lastServerContact(): number | null {
  return lastContact
}

/**
 * The server just answered an authenticated request. Called by the API client on every success
 * that carried the session's token; written to storage at most once a minute.
 */
export function noteAuthenticatedContact(deviceNow: number = Date.now()): void {
  lastContact = serverNow(deviceNow)
  if (deviceNow - lastPersistedAt >= PERSIST_EVERY_MS || deviceNow < lastPersistedAt) {
    lastPersistedAt = deviceNow
    void persistContact(lastContact)
  }
}

/** A sign-in is a contact; recorded at once, not on the minute. */
export async function markSessionStarted(deviceNow: number = Date.now()): Promise<void> {
  lastContact = serverNow(deviceNow)
  lastPersistedAt = deviceNow
  await persistContact(lastContact)
}

/** Reads the recorded contact into memory — at start, before the guard first runs. */
export async function loadSessionContact(): Promise<number | null> {
  try {
    const row = await db.syncMeta.get(CONTACT_META_KEY)
    const value = row?.value
    lastContact = typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    lastContact = null
  }
  return lastContact
}

/** Sign-out, a lock, or a wipe: the next session starts its own count. */
export async function clearSessionContact(): Promise<void> {
  lastContact = null
  lastPersistedAt = Number.NEGATIVE_INFINITY
  try {
    await db.syncMeta.delete(CONTACT_META_KEY)
  } catch {
    /* the row is rewritten at the next sign-in */
  }
}

/**
 * The verdict for this session now, recording «now» as the last contact when none was ever
 * recorded (a session from a build that predates this, or storage that failed) — the generous
 * reading, since nothing proves how long ago the server last answered.
 */
export async function currentOfflineSessionVerdict(
  policy: OfflineSessionPolicy | undefined,
  deviceNow: number = Date.now()
): Promise<OfflineSessionVerdict> {
  if (lastContact == null) {
    await loadSessionContact()
    if (lastContact == null) {
      await markSessionStarted(deviceNow)
    }
  }
  return evaluateOfflineSession(policy, lastContact, rawServerNow(deviceNow))
}

/** Tests only. */
export function resetOfflineSessionForTests(next: number | null = null): void {
  lastContact = next
  lastPersistedAt = Number.NEGATIVE_INFINITY
}
