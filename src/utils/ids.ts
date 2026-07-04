/** Normalize server numeric IDs to strings for IndexedDB keys. */
export function toIdString(value: string | number | null | undefined): string {
  if (value == null) return ''
  return String(value)
}
