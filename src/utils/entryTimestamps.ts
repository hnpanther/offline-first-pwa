import type { LogSheetEntryData } from '@/types'

/**
 * Whether one stored value counts as an **answer**.
 *
 * This is the single definition of "the operator answered this field" on the device, and it has
 * to agree with the server's `FormDataValidationSupport.isAnswered`. A second, looser definition
 * living elsewhere is exactly what cost real readings once: the bundle merge asked
 * `Object.keys(formData).length > 0` instead, so an entry holding `{"Bar": "", "Status": ""}`
 * counted as filled forever and the device's blanks beat the server's values.
 *
 * An emptied attachment field is the case a naive check gets wrong in the other direction:
 * `{ type: 'attachment', ids: [] }` is a non-empty object that means *nothing attached*.
 *
 * `0` and `false` are answers. A reading of zero is a reading.
 */
/**
 * Exported so `restoreArchivedWork` can ask the same question this file already answers.
 * A second definition of "is this an answer" is what gotcha #87 is about — there is one.
 */
export function isValueFilled(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') {
    const ids = (value as { ids?: unknown }).ids
    if (Array.isArray(ids)) return ids.length > 0
  }
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
    filledByName: undefined,
    // Stamped on EVERY operator save, including one that leaves the entry empty. This is the
    // only record that the operator had an opinion here, and `applyEntrySaveTimestamps`
    // deliberately does not touch `createdAt`/`updatedAt` on an empty save — those two are the
    // base this device echoes back to the server, and moving them would make the server refuse
    // the very clear this marker exists to preserve. See `LogSheetEntryData.locallyEditedAt`.
    locallyEditedAt: now
  }
}
