/**
 * The sync interval is stored in **milliseconds** and shown to the operator in **seconds**.
 *
 * That mismatch is the whole reason this module exists. The settings form used to convert
 * seconds→ms in the field's `onChange` *and* again when submitting, so every save multiplied
 * the stored interval by 1000 — even a save where nobody touched the field. One click turned
 * 30 seconds into 30,000, the next into 30,000,000, and sync effectively stopped.
 *
 * Conversion now happens in exactly one place on each side, and the value is clamped on the
 * way to storage rather than trusted: `<input type="number">` gives back `''` for an empty box
 * (`Number('') === 0`, a zero-delay sync loop that would hammer the server) and its `min`/`max`
 * attributes are only a hint the browser is free to ignore.
 */

/** Ten seconds. Below this the device spends more time syncing than working. */
export const MIN_SYNC_INTERVAL_MS = 10_000

/** One hour. Past this the operator would call it broken rather than slow. */
export const MAX_SYNC_INTERVAL_MS = 3_600_000

export const DEFAULT_SYNC_INTERVAL_MS = 30_000

/** Milliseconds in, safe milliseconds out. Anything unusable falls back to the default. */
export function clampSyncInterval(value: unknown): number {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_SYNC_INTERVAL_MS
  return Math.min(Math.max(Math.round(ms), MIN_SYNC_INTERVAL_MS), MAX_SYNC_INTERVAL_MS)
}

/** Milliseconds → the number shown in the seconds box. */
export function toSeconds(ms: unknown): number {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SYNC_INTERVAL_MS / 1000
  return Math.round(value / 1000)
}

/** The number typed into the seconds box → milliseconds. Not clamped: clamping mid-typing
 *  would fight the operator as they type "3" on the way to "300". */
export function fromSeconds(seconds: unknown): number {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return DEFAULT_SYNC_INTERVAL_MS
  return Math.round(value * 1000)
}
