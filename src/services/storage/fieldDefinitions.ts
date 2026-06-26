/**
 * FieldDefinition CRUD — backed by Repository<FieldDefinition>.
 *
 * All sync bookkeeping (UUID, version, outbox) is handled by the Repository.
 * Nothing here touches uuid() or the outbox directly.
 */

import { db } from './db'
import { Repository } from './repository'
import type { FieldDefinition } from '@/types/sync'

const repo = new Repository<FieldDefinition>(db.fieldDefinitions, 'field_definition')

/** Sorted by order, excludes soft-deleted entries. */
export async function getFieldsForClass(classId: string): Promise<FieldDefinition[]> {
  const fields = await repo.findWhere('classId', classId)
  return fields.sort((a, b) => a.order - b.order)
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
