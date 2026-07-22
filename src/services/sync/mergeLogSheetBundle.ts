/**
 * Merges per-log-sheet server bundles into IndexedDB.
 * Server is authoritative for reference data — bulkPut overwrites by id so
 * updated NFC tags / asset metadata apply on every inbox bundle.
 */

import { db } from '@/services/storage/db'
import type {
  LogSheetBundleDto,
  LogSheetContextDto,
  ServerLogSheetEntry
} from '@/services/api'
import type {
  AssetClass,
  AssetEntry,
  Location,
  MainFunction,
  PlantSystem,
  SubFunction
} from '@/types'
import type { FieldDefinition } from '@/types/sync'
import { toIdString } from '@/utils/ids'
import { normalizeFieldOptions } from '@/utils/fieldOptions'
import { toFormFields } from '@/services/storage/fieldDefinitions'
import type { LogSheetEntryData } from '@/types'

async function bulkPutIfAny<T extends { id: string }>(
  table: { bulkPut: (items: T[]) => Promise<unknown> },
  items: T[]
): Promise<void> {
  if (items.length === 0) return
  await table.bulkPut(items)
}

function normalizeLocations(items: Location[] = []): Location[] {
  return items.map(l => ({
    ...l,
    id: toIdString(l.id),
    parentId: l.parentId != null ? toIdString(l.parentId) : undefined
  }))
}

function normalizePlantSystems(items: PlantSystem[] = []): PlantSystem[] {
  return items.map(s => ({
    ...s,
    id: toIdString(s.id),
    locationId: toIdString(s.locationId)
  }))
}

function normalizeMainFunctions(items: MainFunction[] = []): MainFunction[] {
  return items.map(mf => ({
    ...mf,
    id: toIdString(mf.id),
    systemId: mf.systemId != null ? toIdString(mf.systemId) : undefined,
    locationId: mf.locationId != null ? toIdString(mf.locationId) : undefined
  }))
}

function normalizeSubFunctions(items: SubFunction[] = []): SubFunction[] {
  return items.map(sf => ({
    ...sf,
    id: toIdString(sf.id),
    mainFunctionId: sf.mainFunctionId != null ? toIdString(sf.mainFunctionId) : undefined,
    systemId: sf.systemId != null ? toIdString(sf.systemId) : undefined,
    locationId: sf.locationId != null ? toIdString(sf.locationId) : undefined
  }))
}

function normalizeAssetClasses(items: AssetClass[] = []): AssetClass[] {
  return items.map(c => ({
    ...c,
    id: toIdString(c.id),
    // Accept server FieldDefinition-shaped embeds and local FormField shape.
    fields: toFormFields(c.fields as unknown[])
  }))
}

function normalizeAssetEntries(items: AssetEntry[] = []): AssetEntry[] {
  return items.map(a => ({
    ...a,
    id: toIdString(a.id),
    classId: toIdString(a.classId),
    subFunctionId: toIdString(a.subFunctionId)
  }))
}

function normalizeFieldDefinitions(items: FieldDefinition[] = []): FieldDefinition[] {
  return items
    .filter(fd => !fd.deleted)
    .map(fd => ({
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
    }))
}

async function replaceFieldDefinitionsForBundle(
  fieldDefinitions: FieldDefinition[]
): Promise<void> {
  const normalized = normalizeFieldDefinitions(fieldDefinitions)
  if (normalized.length === 0) return

  const classIds = [...new Set(normalized.map(fd => fd.classId))]
  await Promise.all(
    classIds.map(classId =>
      db.fieldDefinitions.where('classId').equals(classId).delete()
    )
  )
  await db.fieldDefinitions.bulkPut(normalized)
}

/** Server-wins merge of scoped reference data into IndexedDB. */
export async function mergeBundleContextToDb(
  context: LogSheetContextDto | null | undefined
): Promise<void> {
  if (!context) return

  const fieldDefs = context.fieldDefinitions ?? []

  await Promise.all([
    bulkPutIfAny(db.locations, normalizeLocations(context.locations ?? [])),
    bulkPutIfAny(db.plantSystems, normalizePlantSystems(context.plantSystems ?? [])),
    bulkPutIfAny(db.mainFunctions, normalizeMainFunctions(context.mainFunctions ?? [])),
    bulkPutIfAny(db.subFunctions, normalizeSubFunctions(context.subFunctions ?? [])),
    bulkPutIfAny(db.assetClasses, normalizeAssetClasses(context.assetClasses ?? [])),
    bulkPutIfAny(db.assetEntries, normalizeAssetEntries(context.assetEntries ?? []))
  ])

  await replaceFieldDefinitionsForBundle(fieldDefs)
}

export function mapServerEntryToLocal(
  entry: ServerLogSheetEntry,
  existing?: LogSheetEntryData,
  preserveLocal = true
): LogSheetEntryData {
  const localForm = existing?.formData ?? {}
  const serverForm = entry.formData ?? {}
  const formData =
    preserveLocal && Object.keys(localForm).length > 0 ? localForm : serverForm

  return {
    assetId: toIdString(entry.assetId),
    assetName: entry.assetName ?? '',
    subFunctionCode: entry.subFunctionCode ?? '',
    subFunctionTag: entry.subFunctionTag ?? '',
    nfcTagId: entry.nfcTagId ?? undefined,
    classId: toIdString(entry.classId),
    formData,
    createdAt: preserveLocal
      ? (existing?.createdAt ?? entry.createdAt ?? undefined)
      : (entry.createdAt ?? undefined),
    updatedAt: preserveLocal
      ? (existing?.updatedAt ?? entry.updatedAt ?? undefined)
      : (entry.updatedAt ?? undefined)
  }
}

/** Merge server entries with locally saved form values and timestamps (same assetId). */
export function mergeEntriesPreservingFormData(
  serverEntries: ServerLogSheetEntry[],
  existingEntries?: LogSheetEntryData[],
  options?: { preserveLocal?: boolean }
): LogSheetEntryData[] {
  const preserveLocal = options?.preserveLocal !== false
  const existingByAsset = new Map(
    (existingEntries ?? []).map(e => [toIdString(e.assetId), e])
  )
  return serverEntries.map(entry =>
    mapServerEntryToLocal(
      entry,
      existingByAsset.get(toIdString(entry.assetId)),
      preserveLocal
    )
  )
}

export function bundleScopeDisplayLabel(bundle: LogSheetBundleDto): string | undefined {
  const label = bundle.context?.scopeDisplayLabel?.trim()
  return label || undefined
}
