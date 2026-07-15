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
