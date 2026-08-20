/**
 * Reading a class's field definitions.
 *
 * <h2>Read-only, on purpose</h2>
 *
 * Field definitions are **server-owned**. They reach the device inside a log-sheet bundle, as
 * that sheet's frozen `field_definitions_snapshot`, and `mergeLogSheetBundle` writes them with
 * `bulkPut`. Nothing on a tablet may create, edit, delete or reorder one — there is no field
 * editor in this app, and a device that invented a field would be describing a form the server
 * has never heard of.
 *
 * <p>This file used to expose the whole CRUD set through a generic `Repository` that also wrote
 * an outbox row per mutation, for a push engine that was never built against an endpoint that
 * does not exist (`POST /api/sync/push`). None of it was reachable from any screen; all of it
 * has been removed. What is left is the two reads the fill page actually performs.
 */

import { db } from './db'
import type { FieldDefinition } from '@/types/sync'
import { toIdString } from '@/utils/ids'

/**
 * Prefer server/numeric ids and newer rows when the same key appears twice.
 *
 * <p>Two sheets of the same class can legitimately carry different snapshots of a field, and the
 * shared table keeps whichever arrived — so the same `key` can exist under two ids. A row whose
 * id looks like a UUID came from a device-era build; a numeric one is the server's.
 */
function dedupeByKey(fields: FieldDefinition[]): FieldDefinition[] {
  const byKey = new Map<string, FieldDefinition>()
  for (const field of fields) {
    if (!field.key) continue
    const prev = byKey.get(field.key)
    if (!prev) {
      byKey.set(field.key, field)
      continue
    }
    const prevIsUuid = prev.id.includes('-')
    const nextIsUuid = field.id.includes('-')
    if (prevIsUuid && !nextIsUuid) {
      byKey.set(field.key, field)
      continue
    }
    if (prevIsUuid === nextIsUuid && (field.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      byKey.set(field.key, field)
    }
  }
  return [...byKey.values()]
}

/**
 * A class's live fields, sorted by `order`, soft-deleted rows excluded.
 *
 * <p>Filtered in memory rather than by the `classId` index: the table holds one row per field of
 * every class the device has ever seen — tens of rows, not thousands — and the `deleted` filter
 * has no index to ride anyway. The sheet's own `fieldDefinitions` copy is what the fill page
 * prefers; this is the fallback for sheets saved before that existed.
 */
export async function getFieldsForClass(classId: string | undefined): Promise<FieldDefinition[]> {
  const normalizedClassId = toIdString(classId)
  if (!normalizedClassId) return []

  const rows = await db.fieldDefinitions.toArray()
  const fields = dedupeByKey(
    rows.filter(f => !f.deleted && toIdString(f.classId) === normalizedClassId)
  )
  return fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
