/**
 * How long this tablet keeps its own copy of a round — backend roadmap §41.
 *
 * The values are the server's: three `app_settings` rows, edited in the panel's «تنظیمات», sent on
 * every `/api/bootstrap` as `deviceRetention` and stored in `settings.deviceRetention`. The purge in
 * `cleanupLogSheets.ts` asks this module for its windows and decides nothing about time on its own.
 *
 * Three rules hold whatever the server sends, and this file is where each one is enforced:
 *
 *  1. **Every value is clamped to the bounds here**, not trusted from the wire or from storage.
 *  2. **A missing or unreadable value never means «purge now».** A number that is not a number
 *     falls back to the server's default for that field; a switch that is not exactly `true` is
 *     off, and off is the direction that keeps undelivered readings.
 *  3. **A device that has never received a policy runs on the constants it shipped with**
 *     (`LEGACY_RETENTION_WINDOWS`), so a newer app against an older server behaves exactly as it
 *     did before. That is the only path on which an undelivered round is purged without an
 *     administrator having switched it on.
 *
 * What is never purged at all — an active draft, a round waiting to sync, an attachment waiting
 * to upload, a reopened round inside its new deadline — is decided in `cleanupLogSheets.ts`,
 * before any of these windows is consulted.
 */

import type { DeviceRetentionPolicy } from '@/types'

const HOUR_MS = 60 * 60 * 1000

/** The server's bounds (`AppSettingsService`). Kept in step by hand; both ends clamp. */
export const SYNCED_RETENTION_HOURS_BOUNDS = { min: 1, max: 720 } as const
export const UNSYNCED_RETENTION_HOURS_BOUNDS = { min: 72, max: 8_760 } as const

/** The server's defaults, used for a single field that arrived unreadable. */
export const DEFAULT_SYNCED_RETENTION_HOURS = 24
export const DEFAULT_UNSYNCED_RETENTION_HOURS = 168

/** How long each kind of local round may stay. `null` means never purged automatically. */
export interface RetentionWindows {
  /** A round the server accepted, counted from `syncedAt`. */
  syncedMs: number
  /** A round the server refused (`syncStatus: 'failed'`), counted from `submittedAt`. */
  failedMs: number | null
  /** A draft whose deadline passed and was never delivered, counted from `dueAt`. */
  expiredDraftMs: number | null
}

/**
 * What this app did before §41, and still does until a server sends a policy.
 *
 * Do not "tidy" these into the new defaults: a newer app talking to an older server must behave
 * exactly as the app that server was deployed with.
 */
export const LEGACY_RETENTION_WINDOWS: Readonly<RetentionWindows> = Object.freeze({
  syncedMs: 24 * HOUR_MS,
  failedMs: 7 * 24 * HOUR_MS,
  expiredDraftMs: 24 * HOUR_MS
})

function clampHours(
  value: unknown,
  bounds: { readonly min: number; readonly max: number },
  fallback: number
): number {
  // A string, null, NaN or Infinity is unreadable, and so is zero or less — the same rule as the
  // server's `parsePositiveInt`. Neither is read as "zero hours", which would mean purge now.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads whatever arrived into a policy that is safe to store and to act on.
 *
 * Returns `undefined` only when there is no block at all (an older server, or `null`) — the
 * caller then keeps what the device already has, the same rule as `attachmentLimits` and
 * `mobilePolicy`. A block that is present but malformed is *not* ignored: it is read field by
 * field, so one bad value cannot cost the others.
 */
export function normalizeDeviceRetention(raw: unknown): DeviceRetentionPolicy | undefined {
  if (raw === undefined || raw === null) return undefined
  const block = isPlainObject(raw) ? raw : {}
  return {
    syncedRetentionHours: clampHours(
      block.syncedRetentionHours,
      SYNCED_RETENTION_HOURS_BOUNDS,
      DEFAULT_SYNCED_RETENTION_HOURS
    ),
    // Exactly `true`, never truthy: "false", 1 or a missing field must not switch a purge on.
    unsyncedPurgeEnabled: block.unsyncedPurgeEnabled === true,
    unsyncedRetentionHours: clampHours(
      block.unsyncedRetentionHours,
      UNSYNCED_RETENTION_HOURS_BOUNDS,
      DEFAULT_UNSYNCED_RETENTION_HOURS
    )
  }
}

/**
 * The windows the purge runs on, from the stored policy.
 *
 * `undefined`/`null` — nothing ever received — gives the legacy constants. Anything else is
 * re-read through `normalizeDeviceRetention`, so a value corrupted in storage is clamped or
 * falls back exactly as one corrupted on the wire would; even a stored value that is not an
 * object at all becomes the server defaults with the purge of undelivered rounds **off**.
 */
export function resolveRetentionWindows(stored: unknown): RetentionWindows {
  const policy = normalizeDeviceRetention(stored)
  if (!policy) return { ...LEGACY_RETENTION_WINDOWS }

  const unsyncedMs = policy.unsyncedPurgeEnabled ? policy.unsyncedRetentionHours * HOUR_MS : null
  return {
    syncedMs: policy.syncedRetentionHours * HOUR_MS,
    failedMs: unsyncedMs,
    expiredDraftMs: unsyncedMs
  }
}
