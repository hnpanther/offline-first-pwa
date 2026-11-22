/**
 * Whether offline fill of one form must wait for its reference lists.
 *
 * The lists are the form's own `requiredLookups` (personnel, and whatever else that form
 * names) — not every list on the server. Online fill stays open: a missing copy still accepts
 * a code. Offline, a list that is not on the device yet has nothing to search, so the form
 * stays closed until the login lease has downloaded it.
 */
export function offlineFormFillBlocked(input: {
  requiredLookups?: Array<{ code: string }> | null
  /** Codes whose local copy has finished a pass (`lookupLists.complete`). */
  completeCodes: string[]
  offline: boolean
}): boolean {
  if (!input.offline) return false
  const needed = (input.requiredLookups ?? [])
    .map(r => r.code.trim().toLowerCase())
    .filter(Boolean)
  if (needed.length === 0) return false
  const have = new Set(input.completeCodes.map(c => c.trim().toLowerCase()))
  return needed.some(code => !have.has(code))
}
