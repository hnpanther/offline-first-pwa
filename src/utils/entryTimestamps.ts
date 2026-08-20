import type { LogSheetEntryData } from '@/types'

function isValueFilled(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function hasEntryFormData(formData: Record<string, unknown> | undefined): boolean {
  return Object.values(formData ?? {}).some(isValueFilled)
}

/**
 * Sets createdAt on first save with data; updatedAt on subsequent edits.
 * Empty saves do not touch timestamps.
 */
export function applyEntrySaveTimestamps(
  entry: LogSheetEntryData,
  formData: Record<string, unknown>,
  now: number = Date.now()
): LogSheetEntryData {
  if (!hasEntryFormData(formData)) {
    return { ...entry, formData }
  }

  const hadData = hasEntryFormData(entry.formData)
  if (!hadData && entry.createdAt == null) {
    return { ...entry, formData, createdAt: now }
  }

  return {
    ...entry,
    formData,
    createdAt: entry.createdAt ?? now,
    updatedAt: now
  }
}

/**
 * Applies one operator's save to an entry: timestamps, how it was captured, and attribution.
 *
 * <p>Lifted out of `LogSheetFillPage` so it can be tested. It was three lines inside a
 * `.map()` in a component with no test harness, and one of them was wrong in a way nothing
 * could see: the spread carried `filledByName` — the *previous* operator's name — straight
 * through the save, so after operator 2 rewrote a reading the screen went on crediting
 * operator 1.
 *
 * <p>`filledByName` is cleared rather than set to the current user. Attribution is the
 * server's decision — it re-stamps an entry only when the value actually changed — and it
 * sends the resolved name back on the next sync. Guessing locally would be a second source of
 * truth for the one fact this whole feature exists to state.
 */
export function applyOperatorEntrySave(
  entry: LogSheetEntryData,
  formData: Record<string, unknown>,
  filledVia: 'nfc' | 'manual',
  now: number = Date.now()
): LogSheetEntryData {
  return {
    ...applyEntrySaveTimestamps(entry, formData, now),
    filledVia,
    filledByName: undefined
  }
}
