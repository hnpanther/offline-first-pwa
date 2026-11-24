/**
 * The answer of a `datetime` field — a calendar instant the operator picked.
 *
 * Mirrors the backend's `DateTimeValues`: stored as
 * `{ type: 'datetime', epochMs: number }`. Accepts a bare epoch or the panel's
 * `yyyy-MM-dd'T'HH:mm` (Asia/Tehran) on the way in so an older or hand-built value still
 * validates. Display is Jalali in Tehran; the stored value is UTC epoch milliseconds.
 */

export const DATETIME_TYPE = 'datetime' as const

export interface DateTimeValue {
  type: typeof DATETIME_TYPE
  epochMs: number
}

/** Soft bounds matching the server (`DateTimeValues.MIN/MAX_EPOCH_MS`). */
export const MIN_EPOCH_MS = 0
export const MAX_EPOCH_MS = 4_102_444_800_000

export function isDateTimeDataType(dataType: string | undefined | null): boolean {
  return (dataType ?? '').trim().toLowerCase() === DATETIME_TYPE
}

function inRange(epoch: number): boolean {
  return Number.isFinite(epoch) && epoch >= MIN_EPOCH_MS && epoch <= MAX_EPOCH_MS
}

/** Parse any inbound shape into epoch millis, or null when unusable. */
export function parseDateTimeEpoch(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') return inRange(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d+$/.test(trimmed)) {
      const epoch = Number(trimmed)
      return inRange(epoch) ? epoch : null
    }
    // Panel picker: yyyy-MM-dd'T'HH:mm in Asia/Tehran — Date parses as local; for the
    // tablet we prefer the object form, so this path is mainly for legacy/tests.
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) && inRange(parsed) ? parsed : null
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const raw = record.epochMs
    const epoch = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    return inRange(epoch) ? epoch : null
  }
  return null
}

export function toDateTimeValue(epochMs: number): DateTimeValue {
  return { type: DATETIME_TYPE, epochMs }
}

/** Canonical stored form, or undefined when blank/unparseable. */
export function canonicalDateTime(value: unknown): DateTimeValue | undefined {
  const epoch = parseDateTimeEpoch(value)
  return epoch == null ? undefined : toDateTimeValue(epoch)
}

export function isUsableDateTime(value: unknown): boolean {
  return parseDateTimeEpoch(value) != null
}
