import type { LogSheet } from '@/types'
import type {
  AssetFieldOverride,
  AssetFieldOverrideSnapshot,
  FieldDefinition,
  FieldValidation,
  FieldValidationRange
} from '@/types/sync'
import { toIdString } from '@/utils/ids'

/**
 * The field definitions a given log sheet should be filled with.
 *
 * A sheet must render the schema it was **raised** with, not whichever schema happened to be
 * merged into the shared per-class table most recently. The server enforces exactly that on
 * its side — a bundle's definitions come from that sheet's own `field_definitions_snapshot`,
 * so two sheets of the same asset class legitimately differ once the class is edited between
 * their generation dates. Mirroring it here is what stops opening sheet B from changing the
 * form sheet A is being filled with.
 *
 * Falls back to the caller's shared-table lookup for sheets stored before `fieldDefinitions`
 * existed on the record, so nothing regresses for work already on a device.
 */
export function sheetFieldDefinitions(
  sheet: Pick<LogSheet, 'fieldDefinitions' | 'fieldOverridesSnapshot'> | null | undefined,
  classId: string | number | undefined,
  fallback: FieldDefinition[] = [],
  assetId?: string | number
): FieldDefinition[] {
  const normalizedClassId = toIdString(classId)
  if (!normalizedClassId) return []

  const own = sheet?.fieldDefinitions
  if (!own || own.length === 0) return applyAssetOverride(fallback, sheet, assetId)

  const scoped = own.filter(fd => toIdString(fd.classId) === normalizedClassId && !fd.deleted)
  // A sheet that carries definitions but none for this class is a real answer — the class is
  // not part of this sheet — so do NOT fall back and quietly show another sheet's schema.
  //
  // NARROW BY CLASS FIRST, THEN APPLY THE ASSET'S OVERRIDE. An override names a field key and
  // nothing else, so applying it to the unfiltered list would collapse the identically-named
  // fields of a class and its sub-class into one. The server makes the same mistake available
  // and guards against it in the same order (backend AGENTS.md #146).
  return applyAssetOverride(sortByDisplayOrder(scoped), sheet, assetId)
}

/**
 * This asset's own warning/danger bands, laid over the definitions its class froze.
 *
 * Display only: the server recomputes severity from its own copy of the same snapshot on every
 * write, so a build of this app that did not do this would still store correct data — it would
 * simply paint the class's colours on a machine that has its own. Which is exactly how this
 * shipped: the override travels in a key an older build ignores.
 */
function applyAssetOverride(
  fields: FieldDefinition[],
  sheet: Pick<LogSheet, 'fieldOverridesSnapshot'> | null | undefined,
  assetId: string | number | undefined
): FieldDefinition[] {
  const key = toIdString(assetId)
  if (!key || fields.length === 0) return fields

  const entry: AssetFieldOverrideSnapshot | undefined = sheet?.fieldOverridesSnapshot?.[key]
  const overrides = entry?.fields
  if (!overrides || Object.keys(overrides).length === 0) return fields

  // Keys are matched case-insensitively, as the server's unique index on lower(field_key)
  // already requires. Matching exactly would let a difference in case silently do nothing,
  // and a danger band that silently does nothing is the worst outcome available here.
  const byKey = new Map<string, AssetFieldOverride>()
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object') byKey.set(k.trim().toLowerCase(), v)
  }
  const ownsFieldList = entry?.source === 'FULL'

  const out: FieldDefinition[] = []
  for (const field of fields) {
    const override = byKey.get(String(field.key ?? '').trim().toLowerCase())
    if (!override) {
      out.push(field)
      continue
    }
    if (ownsFieldList && override.removed) continue
    out.push(merge(field, override, ownsFieldList))
  }

  if (ownsFieldList) {
    const present = new Set(out.map(f => String(f.key ?? '').trim().toLowerCase()))
    // The class id of the rows we are extending. Nothing downstream reads it today — the
    // class filter has already run by this point — but a field carrying a blank one is a trap
    // for the first caller that groups by class.
    const classId = fields[0]?.classId ?? ''
    for (const [k, override] of byKey) {
      if (present.has(k) || override.removed) continue
      out.push(added(k, override, classId))
    }
  }
  return sortByDisplayOrder(out)
}

/** A copy with the override's bands substituted. Never mutates: definitions are shared. */
/**
 * The override's thresholds laid over whatever validation is already there.
 *
 * <p>One place, used by both the merge path (a class field this asset re-bands) and the add
 * path (a field only this asset has). Keeping them apart is how `warningOptions` reached one
 * and not the other.
 *
 * `undefined` means "the override says nothing about this" and what is already there stands.
 * `null` means "this machine has no such threshold", which is a decision, not an absence.
 */
function overrideValidation(
  override: AssetFieldOverride,
  base: FieldValidation
): FieldValidation {
  const validation: FieldValidation = { ...base }
  for (const key of ['warning', 'danger'] as const) {
    if (!(key in override)) continue
    if (override[key] == null) delete validation[key]
    else validation[key] = override[key] as FieldValidationRange
  }
  // Which options are the alert travels with the bands, under the same rule and in BOTH modes:
  // it is a threshold, not structure, so RANGES_ONLY may re-mark it while the class keeps
  // owning the vocabulary itself. An empty array says "no such list" explicitly; neither it
  // nor `null` means "inherit".
  for (const key of ['warningOptions', 'dangerOptions'] as const) {
    if (!(key in override)) continue
    const value = override[key]
    if (value == null) delete validation[key]
    else validation[key] = value.map(v => String(v))
  }
  return validation
}

function merge(field: FieldDefinition, override: AssetFieldOverride, full: boolean): FieldDefinition {
  const validation = overrideValidation(override, { ...(field.validation ?? {}) })
  // The vocabulary itself is structure, so only FULL may replace it.
  if (full && 'options' in override) {
    if (override.options == null) delete validation.options
    else validation.options = override.options
  }
  const merged: FieldDefinition = { ...field, validation }
  if (full) {
    if (override.label != null) merged.label = override.label
    if (override.unit != null) merged.unit = override.unit
    if (override.dataType != null) merged.dataType = override.dataType as FieldDefinition['dataType']
    // Presence, not truthiness: `required: false` on an override is a decision to release a
    // field the class requires, and `=== true` is what the server's own read does with it.
    if ('required' in override) merged.required = override.required === true
    const order = sortOrder(override)
    if (order != null) merged.order = order
  }
  return merged
}

/** `sortOrder` as the server reads it — a number, or a numeric string, or nothing. */
function sortOrder(override: AssetFieldOverride): number | null {
  const raw = override.sortOrder
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim())
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

/** A field the asset adds that its class does not have. FULL only. */
function added(key: string, override: AssetFieldOverride, classId: string): FieldDefinition {
  return {
    id: `asset-override:${key}`,
    classId,
    key,
    label: override.label ?? key,
    dataType: (override.dataType ?? 'number') as FieldDefinition['dataType'],
    unit: override.unit,
    required: override.required === true,
    // Built by the SAME helper `merge` uses, so a threshold key added to one of them cannot
    // go missing from the other. It already did once: `warningOptions`/`dangerOptions` were
    // added to `merge` and not here, so a chosen option coloured on a class field and stayed
    // grey on a field the asset had added — the server judging it correctly the whole time.
    validation: overrideValidation(
      override,
      override.options != null ? { options: override.options } : {}),
    // Last by default, which is where the server also puts it: a definition with no order of
    // its own sorts as Integer.MAX_VALUE there.
    order: sortOrder(override) ?? Number.MAX_SAFE_INTEGER
  } as FieldDefinition
}

/** True when the sheet carries its own frozen schema (i.e. it is not a pre-upgrade record). */
export function hasOwnFieldDefinitions(
  sheet: Pick<LogSheet, 'fieldDefinitions'> | null | undefined
): boolean {
  return (sheet?.fieldDefinitions?.length ?? 0) > 0
}

function sortByDisplayOrder(fields: FieldDefinition[]): FieldDefinition[] {
  return [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
