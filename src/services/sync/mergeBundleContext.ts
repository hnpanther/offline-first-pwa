import { db } from '@/services/storage/db'
import type { LogSheetContextDto } from '@/services/api'
import { toIdString } from '@/utils/ids'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import type { FieldDefinition } from '@/types/sync'

async function mergeCollection<T extends { id: string }>(
  table: { bulkPut: (items: T[]) => Promise<unknown> },
  items: Array<Omit<T, 'id'> & { id: string | number }> | undefined
): Promise<void> {
  if (!items || items.length === 0) return
  const normalized = items.map(item => ({
    ...item,
    id: toIdString(item.id)
  })) as T[]
  await table.bulkPut(normalized)
}

function normalizeContext(context: LogSheetContextDto): LogSheetContextDto {
  return {
    ...context,
    locations: (context.locations ?? []).map(l => ({
      ...l,
      id: toIdString(l.id),
      parentId: l.parentId != null ? toIdString(l.parentId) : undefined
    })),
    plantSystems: (context.plantSystems ?? []).map(s => ({
      ...s,
      id: toIdString(s.id),
      locationId: toIdString(s.locationId)
    })),
    mainFunctions: (context.mainFunctions ?? []).map(mf => ({
      ...mf,
      id: toIdString(mf.id),
      systemId: mf.systemId != null ? toIdString(mf.systemId) : undefined,
      locationId: mf.locationId != null ? toIdString(mf.locationId) : undefined
    })),
    subFunctions: (context.subFunctions ?? []).map(sf => ({
      ...sf,
      id: toIdString(sf.id),
      mainFunctionId: sf.mainFunctionId != null ? toIdString(sf.mainFunctionId) : undefined,
      systemId: sf.systemId != null ? toIdString(sf.systemId) : undefined,
      locationId: sf.locationId != null ? toIdString(sf.locationId) : undefined
    })),
    assetClasses: (context.assetClasses ?? []).map(c => ({
      ...c,
      id: toIdString(c.id),
      fields: c.fields ?? []
    })),
    fieldDefinitions: (context.fieldDefinitions ?? []).map(fd => ({
      ...fd,
      id: toIdString(fd.id),
      classId: toIdString(fd.classId),
      dataType: (fd.dataType?.toLowerCase() ?? 'text') as FieldDefinition['dataType'],
      deleted: fd.deleted ?? false,
      synced: fd.synced ?? true,
      version: fd.version ?? 1,
      order: fd.order ?? 0,
      validation: fd.validation
        ? {
            ...fd.validation,
            options: normalizeFieldOptions(fd.validation.options)
          }
        : fd.validation
    })),
    assetEntries: (context.assetEntries ?? []).map(a => ({
      ...a,
      id: toIdString(a.id),
      classId: toIdString(a.classId),
      subFunctionId: toIdString(a.subFunctionId)
    }))
  }
}

/** Upsert scoped reference data from a log-sheet bundle into IndexedDB. */
export async function mergeBundleContext(
  context: LogSheetContextDto | null | undefined
): Promise<void> {
  if (!context) return
  const data = normalizeContext(context)
  await Promise.all([
    mergeCollection(db.locations, data.locations),
    mergeCollection(db.plantSystems, data.plantSystems),
    mergeCollection(db.mainFunctions, data.mainFunctions),
    mergeCollection(db.subFunctions, data.subFunctions),
    mergeCollection(db.assetClasses, data.assetClasses),
    mergeCollection(db.fieldDefinitions, data.fieldDefinitions),
    mergeCollection(db.assetEntries, data.assetEntries)
  ])
}
