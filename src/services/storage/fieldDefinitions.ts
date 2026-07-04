/**
 * FieldDefinition CRUD — backed by Repository<FieldDefinition>.
 *
 * All sync bookkeeping (UUID, version, outbox) is handled by the Repository.
 * Nothing here touches uuid() or the outbox directly.
 */

import { db } from './db'
import { Repository } from './repository'
import type { FieldDefinition, FieldDataType } from '@/types/sync'
import type { FormField } from '@/types'
import { toIdString } from '@/utils/ids'

const repo = new Repository<FieldDefinition>(db.fieldDefinitions, 'field_definition')

/** Sorted by order, excludes soft-deleted entries. */
export async function getFieldsForClass(classId: string | undefined): Promise<FieldDefinition[]> {
  const normalizedClassId = toIdString(classId)
  if (!normalizedClassId) return []

  let fields = (await repo.findAll()).filter(
    f => toIdString(f.classId) === normalizedClassId
  )

  const assetClass = await db.assetClasses.get(normalizedClassId)

  if (assetClass?.fields?.length) {
    const classKeys = assetClass.fields.map(f => f.name)
    const defKeys = fields.map(f => f.key)
    const needsSync =
      fields.length === 0 ||
      classKeys.length !== defKeys.length ||
      classKeys.some((k, i) => k !== defKeys[i]) ||
      assetClass.fields.some((f, i) => {
        const def = fields[i]
        return !def || def.label !== f.label || def.dataType !== f.type
      })

    if (needsSync) {
      await syncClassFieldsFromFormFields(normalizedClassId, assetClass.fields)
      fields = (await repo.findAll()).filter(
        f => toIdString(f.classId) === normalizedClassId
      )
    }
  }

  if (fields.length === 0 && assetClass?.fields?.length) {
    return formFieldsToDefinitions(normalizedClassId, assetClass.fields)
  }

  return fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function formFieldsToDefinitions(classId: string, fields: FormField[]): FieldDefinition[] {
  const now = Date.now()
  return fields.map((field, index) => ({
    id: `embedded-${classId}-${field.name}`,
    classId,
    key: field.name,
    label: field.label,
    dataType: field.type as FieldDataType,
    unit: field.unit,
    required: field.required ?? false,
    validation: {
      min: field.min,
      max: field.max,
      options: field.options
    },
    order: index,
    createdAt: now,
    updatedAt: now,
    version: 1,
    deleted: false,
    synced: true
  }))
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
  const existing = await repo.findWhere('classId', classId)
  const existingByKey = new Map(existing.map(f => [f.key, f]))
  const newKeys = new Set(fields.map(f => f.name))

  await Promise.all(
    fields.map(async (field, index) => {
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
