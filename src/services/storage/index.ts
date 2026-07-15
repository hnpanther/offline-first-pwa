import { db, DEFAULT_SETTINGS } from './db'
import type {
  DataRecord,
  AssetClass,
  AssetEntry,
  AppSettings,
  SyncStatus,
  Location,
  PlantSystem,
  MainFunction,
  SubFunction,
  LogSheetTemplate,
  LogSheet
} from '@/types'
import { v4 as uuidv4 } from 'uuid'
import {
  syncClassFieldsFromFormFields,
  deleteFieldsForClass,
} from './fieldDefinitions'

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export async function saveRecord(
  data: Omit<DataRecord, 'id' | 'localId' | 'createdAt' | 'updatedAt' | 'syncStatus'>
): Promise<DataRecord> {
  const now = Date.now()
  const record: DataRecord = {
    ...data,
    localId: uuidv4(),
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending'
  }
  const id = await db.records.add(record)
  return { ...record, id: id as number }
}

export async function updateRecord(
  localId: string,
  updates: Partial<DataRecord>
): Promise<void> {
  const existing = await db.records.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`Record not found: ${localId}`)
  await db.records.update(existing.id, { ...updates, updatedAt: Date.now() })
}

export async function approveRecord(localId: string): Promise<void> {
  const existing = await db.records.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`Record not found: ${localId}`)
  await db.records.update(existing.id, {
    recordStatus: 'approved',
    syncStatus: 'pending',
    updatedAt: Date.now()
  })
}

export async function getRecord(localId: string): Promise<DataRecord | undefined> {
  return db.records.where('localId').equals(localId).first()
}

export async function getAllRecords(): Promise<DataRecord[]> {
  return db.records.orderBy('createdAt').reverse().toArray()
}

export async function getPendingRecords(): Promise<DataRecord[]> {
  const candidates = await db.records
    .where('syncStatus')
    .anyOf(['pending', 'failed'])
    .toArray()
  // Only sync approved records (or legacy records without recordStatus)
  return candidates.filter(r => !r.recordStatus || r.recordStatus === 'approved')
}

export async function updateRecordSyncStatus(
  localId: string,
  status: SyncStatus,
  extra?: { serverId?: string; syncError?: string; syncedAt?: number }
): Promise<void> {
  const existing = await db.records.where('localId').equals(localId).first()
  if (!existing?.id) return
  await db.records.update(existing.id, {
    syncStatus: status,
    updatedAt: Date.now(),
    ...(extra ?? {})
  })
}

export async function deleteRecord(localId: string): Promise<void> {
  await db.records.where('localId').equals(localId).delete()
}

export async function getPendingCount(): Promise<number> {
  const candidates = await db.records
    .where('syncStatus')
    .anyOf(['pending', 'failed'])
    .toArray()
  return candidates.filter(r => !r.recordStatus || r.recordStatus === 'approved').length
}

// ---------------------------------------------------------------------------
// Asset Classes (was Asset Types)
// ---------------------------------------------------------------------------

export async function getAllAssetClasses(): Promise<AssetClass[]> {
  return db.assetClasses.orderBy('createdAt').toArray()
}

export async function getAssetClass(id: string): Promise<AssetClass | undefined> {
  return db.assetClasses.get(id)
}

export async function saveAssetClass(
  data: Omit<AssetClass, 'id' | 'createdAt' | 'updatedAt'>
): Promise<AssetClass> {
  const now = Date.now()
  const assetClass: AssetClass = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.assetClasses.add(assetClass)
  await syncClassFieldsFromFormFields(assetClass.id, data.fields)
  return assetClass
}

export async function updateAssetClass(
  id: string,
  updates: Partial<Omit<AssetClass, 'id' | 'createdAt'>>
): Promise<void> {
  await db.assetClasses.update(id, { ...updates, updatedAt: Date.now() })
  if (updates.fields) {
    await syncClassFieldsFromFormFields(id, updates.fields)
  }
}

export async function deleteAssetClass(id: string): Promise<void> {
  await deleteFieldsForClass(id)
  await db.assetClasses.delete(id)
}

// ---------------------------------------------------------------------------
// Asset Entries (NFC tag → asset class mapping)
// ---------------------------------------------------------------------------

export async function getAllAssetEntries(): Promise<AssetEntry[]> {
  const entries = await db.assetEntries.toArray()
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getAssetEntryByTagId(nfcTagId: string): Promise<AssetEntry | undefined> {
  return db.assetEntries.where('nfcTagId').equals(nfcTagId).first()
}

export async function saveAssetEntry(
  data: Omit<AssetEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<AssetEntry> {
  const now = Date.now()
  const entry: AssetEntry = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.assetEntries.add(entry)
  return entry
}

export async function updateAssetEntry(
  id: string,
  updates: Partial<Omit<AssetEntry, 'id' | 'createdAt'>>
): Promise<void> {
  await db.assetEntries.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteAssetEntry(id: string): Promise<void> {
  await db.assetEntries.delete(id)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  if (!row) return { ...DEFAULT_SETTINGS }
  const { key: _key, ...settings } = row
  return { ...DEFAULT_SETTINGS, ...settings } as AppSettings
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', ...settings })
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function getAllLocations(): Promise<Location[]> {
  const items = await db.locations.toArray()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getLocation(id: string): Promise<Location | undefined> {
  return db.locations.get(id)
}

export async function saveLocation(
  data: Omit<Location, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Location> {
  const now = Date.now()
  const location: Location = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.locations.add(location)
  return location
}

export async function updateLocation(
  id: string,
  updates: Partial<Omit<Location, 'id' | 'createdAt'>>
): Promise<void> {
  await db.locations.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteLocation(id: string): Promise<void> {
  await db.locations.delete(id)
}

// ---------------------------------------------------------------------------
// Plant Systems
// ---------------------------------------------------------------------------

export async function getAllPlantSystems(): Promise<PlantSystem[]> {
  const items = await db.plantSystems.toArray()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getPlantSystem(id: string): Promise<PlantSystem | undefined> {
  return db.plantSystems.get(id)
}

export async function savePlantSystem(
  data: Omit<PlantSystem, 'id' | 'createdAt' | 'updatedAt'>
): Promise<PlantSystem> {
  const now = Date.now()
  const system: PlantSystem = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.plantSystems.add(system)
  return system
}

export async function updatePlantSystem(
  id: string,
  updates: Partial<Omit<PlantSystem, 'id' | 'createdAt'>>
): Promise<void> {
  await db.plantSystems.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deletePlantSystem(id: string): Promise<void> {
  await db.plantSystems.delete(id)
}

// ---------------------------------------------------------------------------
// Main Functions
// ---------------------------------------------------------------------------

export async function getAllMainFunctions(): Promise<MainFunction[]> {
  const items = await db.mainFunctions.toArray()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getMainFunction(id: string): Promise<MainFunction | undefined> {
  return db.mainFunctions.get(id)
}

export async function saveMainFunction(
  data: Omit<MainFunction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<MainFunction> {
  const now = Date.now()
  const mainFunc: MainFunction = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.mainFunctions.add(mainFunc)
  return mainFunc
}

export async function updateMainFunction(
  id: string,
  updates: Partial<Omit<MainFunction, 'id' | 'createdAt'>>
): Promise<void> {
  await db.mainFunctions.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteMainFunction(id: string): Promise<void> {
  await db.mainFunctions.delete(id)
}

// ---------------------------------------------------------------------------
// Sub Functions
// ---------------------------------------------------------------------------

export async function getAllSubFunctions(): Promise<SubFunction[]> {
  const items = await db.subFunctions.toArray()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getSubFunction(id: string): Promise<SubFunction | undefined> {
  return db.subFunctions.get(id)
}

export async function saveSubFunction(
  data: Omit<SubFunction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<SubFunction> {
  const now = Date.now()
  const subFunc: SubFunction = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.subFunctions.add(subFunc)
  return subFunc
}

export async function updateSubFunction(
  id: string,
  updates: Partial<Omit<SubFunction, 'id' | 'createdAt'>>
): Promise<void> {
  await db.subFunctions.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteSubFunction(id: string): Promise<void> {
  await db.subFunctions.delete(id)
}

export async function lookupSubFunctionByTag(tag: string): Promise<SubFunction | undefined> {
  return db.subFunctions.where('tag').equals(tag).first()
}

export async function getSubFunctionPath(subFunctionId: string): Promise<string> {
  const subFunc = await db.subFunctions.get(subFunctionId)
  if (!subFunc) return ''

  const parts: string[] = [subFunc.name]

  // Resolve main function
  if (subFunc.mainFunctionId) {
    const mainFunc = await db.mainFunctions.get(subFunc.mainFunctionId)
    if (mainFunc) {
      parts.unshift(mainFunc.name)
      // Resolve system or location from mainFunction
      if (mainFunc.systemId) {
        const system = await db.plantSystems.get(mainFunc.systemId)
        if (system) {
          parts.unshift(system.name)
          const loc = await db.locations.get(system.locationId)
          if (loc) parts.unshift(loc.name)
        }
      } else if (mainFunc.locationId) {
        const loc = await db.locations.get(mainFunc.locationId)
        if (loc) parts.unshift(loc.name)
      }
    }
  } else if (subFunc.systemId) {
    const system = await db.plantSystems.get(subFunc.systemId)
    if (system) {
      parts.unshift(system.name)
      const loc = await db.locations.get(system.locationId)
      if (loc) parts.unshift(loc.name)
    }
  } else if (subFunc.locationId) {
    const loc = await db.locations.get(subFunc.locationId)
    if (loc) parts.unshift(loc.name)
  }

  return parts.join(' / ')
}

// ---------------------------------------------------------------------------
// Assets in Scope (for LogSheet)
// ---------------------------------------------------------------------------

export async function getAssetsInScope(
  scopeType: 'location' | 'system' | 'mainFunction',
  scopeId: string,
  classId?: string
): Promise<AssetEntry[]> {
  const [allAssets, allSubFunctions, allMainFunctions, allSystems, allLocations] = await Promise.all([
    db.assetEntries.toArray(),
    db.subFunctions.toArray(),
    db.mainFunctions.toArray(),
    db.plantSystems.toArray(),
    db.locations.toArray()
  ])

  const systemMap = new Map(allSystems.map(s => [s.id, s]))
  const mainFunctionMap = new Map(allMainFunctions.map(mf => [mf.id, mf]))

  // For location scope: build the full subtree of location IDs via BFS.
  // A location can have child locations (parentId), so we must traverse all
  // descendants — not just the selected location itself.
  let locationScope: Set<string> | null = null
  if (scopeType === 'location') {
    locationScope = new Set([scopeId])
    const queue = [scopeId]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const loc of allLocations) {
        if (loc.parentId === current && !locationScope.has(loc.id)) {
          locationScope.add(loc.id)
          queue.push(loc.id)
        }
      }
    }
  }

  const inScopeSubFunctionIds = new Set<string>()

  for (const sf of allSubFunctions) {
    let inScope = false

    if (scopeType === 'location' && locationScope) {
      // SubFunction directly under any location in the subtree
      if (sf.locationId && locationScope.has(sf.locationId)) {
        inScope = true
      } else if (sf.systemId) {
        // SubFunction → System → Location (in subtree)
        const sys = systemMap.get(sf.systemId)
        if (sys && locationScope.has(sys.locationId)) inScope = true
      } else if (sf.mainFunctionId) {
        // SubFunction → MainFunction → Location or System → Location
        const mf = mainFunctionMap.get(sf.mainFunctionId)
        if (mf) {
          if (mf.locationId && locationScope.has(mf.locationId)) {
            inScope = true
          } else if (mf.systemId) {
            const sys = systemMap.get(mf.systemId)
            if (sys && locationScope.has(sys.locationId)) inScope = true
          }
        }
      }
    } else if (scopeType === 'system') {
      if (sf.systemId === scopeId) {
        inScope = true
      } else if (sf.mainFunctionId) {
        const mf = mainFunctionMap.get(sf.mainFunctionId)
        if (mf && mf.systemId === scopeId) inScope = true
      }
    } else if (scopeType === 'mainFunction') {
      if (sf.mainFunctionId === scopeId) inScope = true
    }

    if (inScope) inScopeSubFunctionIds.add(sf.id)
  }

  return allAssets.filter(a => {
    if (!inScopeSubFunctionIds.has(a.subFunctionId)) return false
    if (classId && String(a.classId) !== String(classId)) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Log Sheet Templates
// ---------------------------------------------------------------------------

export async function getAllLogSheetTemplates(): Promise<LogSheetTemplate[]> {
  const items = await db.logSheetTemplates.toArray()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function getLogSheetTemplate(id: string): Promise<LogSheetTemplate | undefined> {
  return db.logSheetTemplates.get(id)
}

export async function saveLogSheetTemplate(
  data: Omit<LogSheetTemplate, 'id' | 'createdAt' | 'updatedAt'>
): Promise<LogSheetTemplate> {
  const now = Date.now()
  const template: LogSheetTemplate = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.logSheetTemplates.add(template)
  return template
}

export async function updateLogSheetTemplate(
  id: string,
  updates: Partial<Omit<LogSheetTemplate, 'id' | 'createdAt'>>
): Promise<void> {
  await db.logSheetTemplates.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteLogSheetTemplate(id: string): Promise<void> {
  await db.logSheetTemplates.delete(id)
}

// ---------------------------------------------------------------------------
// Log Sheets
// ---------------------------------------------------------------------------

export async function saveLogSheet(
  data: Omit<LogSheet, 'id' | 'syncStatus' | 'createdAt' | 'updatedAt'> &
    Partial<Pick<LogSheet, 'createdAt' | 'updatedAt' | 'syncStatus'>>
): Promise<LogSheet> {
  const now = Date.now()
  const logSheet: LogSheet = {
    ...data,
    id: data.localId,
    entries: data.entries ?? [],
    syncStatus: data.syncStatus ?? 'pending',
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now
  }
  await db.logSheets.put(logSheet)
  return logSheet
}

export async function updateLogSheet(
  localId: string,
  updates: Partial<LogSheet>
): Promise<void> {
  const existing = await db.logSheets.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`LogSheet not found: ${localId}`)

  if ('syncError' in updates && updates.syncError === undefined) {
    const next: LogSheet = { ...existing, ...updates, updatedAt: Date.now() }
    delete next.syncError
    await db.logSheets.put(next)
    return
  }

  await db.logSheets.update(existing.id, { ...updates, updatedAt: Date.now() })
}

/** Move a locally submitted sheet back to draft (clears outbound queue metadata). */
export async function revertLogSheetToDraft(localId: string): Promise<void> {
  await resetLogSheetToOpenDraft(localId)
}

/** Reset stale local completion when server still shows the sheet as open. */
export async function resetLogSheetToOpenDraft(
  localId: string,
  options?: { clearEntryFormData?: boolean }
): Promise<void> {
  const existing = await db.logSheets.where('localId').equals(localId).first()
  if (!existing?.id) throw new Error(`LogSheet not found: ${localId}`)

  const next: LogSheet = {
    ...existing,
    status: 'draft',
    syncStatus: 'pending',
    updatedAt: Date.now(),
    entries: options?.clearEntryFormData
      ? existing.entries.map(e => ({
          ...e,
          formData: {},
          createdAt: undefined,
          updatedAt: undefined
        }))
      : existing.entries
  }
  delete next.submittedAt
  delete next.completedAt
  delete next.clientActionId
  delete next.syncError
  delete next.syncedAt

  await db.logSheets.put(next)
}

export async function getAllLogSheets(): Promise<LogSheet[]> {
  const items = await db.logSheets.toArray()
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getLogSheet(localId: string): Promise<LogSheet | undefined> {
  return db.logSheets.where('localId').equals(localId).first()
}

export async function getLogSheetByServerId(serverId: string): Promise<LogSheet | undefined> {
  return db.logSheets.where('serverId').equals(serverId).first()
}

export async function deleteLogSheet(localId: string): Promise<void> {
  await db.logSheets.where('localId').equals(localId).delete()
}
