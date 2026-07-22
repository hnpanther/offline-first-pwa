/**
 * FieldDefinition CRUD — backed by Repository<FieldDefinition>.
 *
 * All sync bookkeeping (UUID, version, outbox) is handled by the Repository.
 * Nothing here touches uuid() or the outbox directly.
 */

import { db } from './db'
import { Repository } from './repository'
import type { FieldDefinition } from '@/types/sync'
import type { FormField, FormFieldType } from '@/types'
import { toIdString } from '@/utils/ids'

const repo = new Repository<FieldDefinition>(db.fieldDefinitions, 'field_definition')

/**
 * Server embeds fields as FieldDefinition-shaped maps ({ key, dataType }).
 * Local admin UI uses FormField ({ name, type }). Accept both.
 */
export function toFormFields(fields: unknown[] | undefined | null): FormField[] {
  if (!fields?.length) return []
  return fields
    .map(raw => {
      const f = raw as Record<string, unknown>
      const name = String(f.name ?? f.key ?? '').trim()
      if (!name) return null
      const type = String(f.type ?? f.dataType ?? 'text').toLowerCase() as FormFieldType
      const validation =
        f.validation && typeof f.validation === 'object'
          ? (f.validation as Record<string, unknown>)
          : undefined
      const field: FormField = {
        name,
        label: String(f.label ?? name),
        type,
        required: Boolean(f.required),
        unit: f.unit != null ? String(f.unit) : undefined,
        min:
          typeof f.min === 'number'
            ? f.min
            : typeof validation?.min === 'number'
              ? validation.min
              : undefined,
        max:
          typeof f.max === 'number'
            ? f.max
            : typeof validation?.max === 'number'
              ? validation.max
              : undefined,
        options: Array.isArray(f.options)
          ? (f.options as FormField['options'])
          : Array.isArray(validation?.options)
            ? (validation.options as FormField['options'])
            : undefined,
        helperText: f.helperText != null ? String(f.helperText) : undefined
      }
      return field
    })
    .filter((f): f is FormField => f != null)
}

/** Prefer server/numeric ids and newer rows when the same key appears twice. */
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

/** Sorted by order, excludes soft-deleted entries. */
export async function getFieldsForClass(classId: string | undefined): Promise<FieldDefinition[]> {
  const normalizedClassId = toIdString(classId)
  if (!normalizedClassId) return []

  let fields = dedupeByKey(
    (await repo.findAll()).filter(f => toIdString(f.classId) === normalizedClassId)
  )

  // Authoritative rows from the server bundle — never re-import AssetClass.fields on top.
  if (fields.length > 0) {
    return fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  // Legacy fallback: only when fieldDefinitions is empty.
  const assetClass = await db.assetClasses.get(normalizedClassId)
  const embedded = toFormFields(assetClass?.fields)
  if (embedded.length > 0) {
    await syncClassFieldsFromFormFields(normalizedClassId, embedded)
    fields = dedupeByKey(
      (await repo.findAll()).filter(f => toIdString(f.classId) === normalizedClassId)
    )
  }

  return fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export async function getFieldDefinition(id: string): Promise<FieldDefinition | undefined> {
  return repo.findById(id)
}

export async function saveFieldDefinition(
  data: Omit<FieldDefinition, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'deleted' | 'synced'>
): Promise<FieldDefinition> {
  return repo.create(data)
}

export async function updateFieldDefinition(
  id: string,
  updates: Partial<Omit<FieldDefinition, 'id' | 'createdAt' | 'version' | 'synced'>>
): Promise<FieldDefinition> {
  return repo.update(id, updates)
}

export async function deleteFieldDefinition(id: string): Promise<void> {
  return repo.softDelete(id)
}

/**
 * Batch-reorder fields within a class.
 * orderedIds is the new desired sequence (index 0 = first displayed).
 */
export async function reorderFieldDefinitions(
  classId: string,
  orderedIds: string[]
): Promise<void> {
  await Promise.all(
    orderedIds.map((id, index) => repo.update(id, { classId, order: index }))
  )
}

function formFieldToDefinitionData(
  field: FormField,
  classId: string,
  order: number
): Omit<FieldDefinition, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'deleted' | 'synced'> {
  return {
    classId,
    key: field.name,
    label: field.label,
    dataType: field.type as FieldDefinition['dataType'],
    unit: field.unit,
    required: field.required ?? false,
    validation: {
      min: field.min,
      max: field.max,
      options: field.options,
    },
    order,
  }
}

/**
 * Keep fieldDefinitions in sync with AssetClass.fields[].
 * Admin UI still edits the embedded fields array; LogSheet reads fieldDefinitions.
 */
export async function syncClassFieldsFromFormFields(
  classId: string,
  fields: FormField[]
): Promise<void> {
  const formFields = toFormFields(fields)
  const existing = await repo.findWhere('classId', classId)
  const existingByKey = new Map(existing.map(f => [f.key, f]))
  const newKeys = new Set(formFields.map(f => f.name))

  await Promise.all(
    formFields.map(async (field, index) => {
      const data = formFieldToDefinitionData(field, classId, index)
      const match = existingByKey.get(field.name)
      if (match) {
        await repo.update(match.id, data)
      } else {
        await repo.create(data)
      }
    })
  )

  await Promise.all(
    existing
      .filter(f => !newKeys.has(f.key))
      .map(f => repo.softDelete(f.id))
  )
}

/** Soft-delete all field definitions belonging to a class. */
export async function deleteFieldsForClass(classId: string): Promise<void> {
  const existing = await repo.findWhere('classId', classId)
  await Promise.all(existing.map(f => repo.softDelete(f.id)))
}

/** Clone all field definitions from one class to a new class. */
export async function cloneFieldsToClass(
  sourceClassId: string,
  targetClassId: string
): Promise<FieldDefinition[]> {
  const source = await getFieldsForClass(sourceClassId)
  return Promise.all(
    source.map(f =>
      repo.create({
        classId: targetClassId,
        key: f.key,
        label: f.label,
        dataType: f.dataType,
        unit: f.unit,
        required: f.required,
        validation: f.validation,
        order: f.order,
      })
    )
  )
}
