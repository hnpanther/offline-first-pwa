import type { FieldDefinition } from '@/types/sync'

/** A reader that can fill one field's value from a label. */
export type ScanFieldSource = 'NFC' | 'QR' | 'BARCODE'

const KNOWN: ScanFieldSource[] = ['NFC', 'QR', 'BARCODE']

/**
 * Reading a field's scan configuration off its definition.
 *
 * <h3>What this is, and what it is emphatically not</h3>
 *
 * `logSheet.scanMode` says how the operator reaches an **asset**. This says how one
 * **question** may be answered on an asset they already have open — a nameplate serial typed
 * thirty characters at a time, or read off the label in one.
 *
 * The two must not meet. A value scanned here:
 *
 * - **never goes through `matchLogSheetEntryByTag`**, which answers "which asset on this round
 *   is this?" and returns `notInSheet` for anything else. A nameplate serial is not supposed to
 *   match an asset, so routing it there would reject every correct read;
 * - **never changes `filledVia`**, which records how the *entry* was reached and is what the
 *   data-quality report counts. A field scanned inside a manually-opened entry does not make
 *   that entry a scanned one.
 *
 * <h3>Read defensively, defaulting to fillable</h3>
 *
 * This comes out of a JSONB blob written by a server that may be newer or older than this
 * build. Every malformed shape resolves to "not scannable, and you may type" — the direction
 * that leaves an operator able to finish the round. The opposite default would turn an
 * unreadable blob into a form nobody can complete, in a plant, offline.
 */
export interface ScanFieldConfig {
  /** Readers offered for this field, in the order the administrator chose. */
  sources: ScanFieldSource[]
  /** Whether typing is still allowed. True unless the definition explicitly says otherwise. */
  manual: boolean
}

/** The data types a label can resolve into: text, or a number written as text. */
export function supportsScanFill(dataType: string | undefined): boolean {
  return dataType === 'text' || dataType === 'number'
}

/**
 * This field's scan configuration, or `null` when it is an ordinary typed field.
 *
 * `null` is the answer for the overwhelming majority of fields and for every malformed blob,
 * so a caller that only checks for null behaves correctly in both cases.
 */
export function scanFieldConfig(field: FieldDefinition | undefined): ScanFieldConfig | null {
  if (!field || !supportsScanFill(field.dataType)) return null

  const raw = (field.validation as { scan?: unknown } | undefined)?.scan
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const declared = (raw as { sources?: unknown }).sources
  if (!Array.isArray(declared)) return null

  const sources: ScanFieldSource[] = []
  for (const candidate of declared) {
    if (typeof candidate !== 'string') continue
    const name = candidate.trim().toUpperCase() as ScanFieldSource
    if (KNOWN.includes(name) && !sources.includes(name)) sources.push(name)
  }
  if (sources.length === 0) return null

  // `manual` is true unless stored exactly false — see the interface note on why the default
  // points this way.
  return { sources, manual: (raw as { manual?: unknown }).manual !== false }
}

/**
 * What a scan actually puts in the field.
 *
 * **The payload, trimmed, and nothing else.** No parsing, no URL unwrapping, no prefix
 * stripping — the same rule the asset-identifying scanner follows, and for the same reason: a
 * label printed from the panel and one printed from a label machine must resolve identically,
 * or the one that fails is the one already in the plant.
 *
 * Returns `null` for a payload with nothing in it, so a caller can tell "read nothing" from
 * "read an empty string" and leave the field untouched rather than clearing it.
 */
export function scannedFieldValue(payload: string | null | undefined): string | null {
  const value = (payload ?? '').trim()
  return value.length > 0 ? value : null
}
