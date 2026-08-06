import type { LogSheet } from '@/types'
import type { FieldDefinition } from '@/types/sync'
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
  sheet: Pick<LogSheet, 'fieldDefinitions'> | null | undefined,
  classId: string | number | undefined,
  fallback: FieldDefinition[] = []
): FieldDefinition[] {
  const normalizedClassId = toIdString(classId)
  if (!normalizedClassId) return []

  const own = sheet?.fieldDefinitions
  if (!own || own.length === 0) return fallback

  const scoped = own.filter(fd => toIdString(fd.classId) === normalizedClassId && !fd.deleted)
  // A sheet that carries definitions but none for this class is a real answer — the class is
  // not part of this sheet — so do NOT fall back and quietly show another sheet's schema.
  return sortByDisplayOrder(scoped)
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
