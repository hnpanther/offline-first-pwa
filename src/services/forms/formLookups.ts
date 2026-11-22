import { db } from '@/services/storage/db'
import type { RequiredLookup } from '@/services/api'

const REQUIRED_FORM_LOOKUPS_KEY = 'requiredFormLookups'
const PRIMARY_UNIT_ID_KEY = 'primaryUnitId'
const ACCESSIBLE_UNIT_IDS_KEY = 'accessibleUnitIds'

/** Persists the bootstrap lease set for FILL-able forms. */
export async function saveRequiredFormLookups(lookups: RequiredLookup[]): Promise<void> {
  await db.syncMeta.put({ key: REQUIRED_FORM_LOOKUPS_KEY, value: lookups })
}

export async function loadRequiredFormLookups(): Promise<RequiredLookup[]> {
  const row = await db.syncMeta.get(REQUIRED_FORM_LOOKUPS_KEY)
  if (!Array.isArray(row?.value)) return []
  return row.value as RequiredLookup[]
}

/** Drop the form lease on sign-out so the next operator does not inherit it. */
export async function clearRequiredFormLookups(): Promise<void> {
  await db.syncMeta.delete(REQUIRED_FORM_LOOKUPS_KEY)
}

export async function saveBootstrapUnitContext(input: {
  primaryUnitId?: string | null
  accessibleUnitIds?: string[]
}): Promise<void> {
  if (input.primaryUnitId !== undefined) {
    await db.syncMeta.put({ key: PRIMARY_UNIT_ID_KEY, value: input.primaryUnitId })
  }
  if (input.accessibleUnitIds !== undefined) {
    await db.syncMeta.put({ key: ACCESSIBLE_UNIT_IDS_KEY, value: input.accessibleUnitIds })
  }
}

export async function loadPrimaryUnitId(): Promise<string | null> {
  const row = await db.syncMeta.get(PRIMARY_UNIT_ID_KEY)
  return typeof row?.value === 'string' && row.value ? row.value : null
}

export async function loadAccessibleUnitIds(): Promise<string[]> {
  const row = await db.syncMeta.get(ACCESSIBLE_UNIT_IDS_KEY)
  if (!Array.isArray(row?.value)) return []
  return (row.value as unknown[]).map(String)
}

/**
 * The lookup set downloaded on login / inbox sync.
 *
 * Round lists (`requiredLookups` on assigned bundles) unioned with the bootstrap lease of
 * lists that FILL-able forms actually use (`requiredFormLookups`). Nothing else — not every
 * catalog on the server, and not lists no open round and no fillable form named.
 *
 * `syncRequiredLookups` set-diffs: calling it with only one source would drop the other.
 */
export function loginLookupLease(
  roundLookups: RequiredLookup[],
  formLookups: RequiredLookup[]
): RequiredLookup[] {
  return mergeRequiredLookups(roundLookups, formLookups)
}

/**
 * Unions round + form lookup requirements without dropping either side.
 * `syncRequiredLookups` set-diffs: calling it with only one source would drop the other.
 */
export function mergeRequiredLookups(
  ...groups: RequiredLookup[][]
): RequiredLookup[] {
  const wanted = new Map<string, RequiredLookup>()
  for (const group of groups) {
    for (const r of group) {
      const key = r.code.trim().toLowerCase()
      if (!key) continue
      const prev = wanted.get(key)
      if (!prev || r.revision > prev.revision) wanted.set(key, r)
    }
  }
  return [...wanted.values()]
}
