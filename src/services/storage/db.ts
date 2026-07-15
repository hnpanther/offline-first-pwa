import Dexie, { type Table } from 'dexie'
import { v4 as uuidv4 } from 'uuid'
import type { DataRecord, AssetClass, AssetEntry, AppSettings, Location, PlantSystem, MainFunction, SubFunction, LogSheetTemplate, LogSheet, LogSheetUserArchive, FormField, OperationalUnit } from '@/types'
import type { FieldDefinition, OutboxEntry, SyncMeta } from '@/types/sync'

class AppDatabase extends Dexie {
  records!: Table<DataRecord>
  assetClasses!: Table<AssetClass>
  assetEntries!: Table<AssetEntry>
  settings!: Table<AppSettings & { key: string }>
  locations!: Table<Location>
  plantSystems!: Table<PlantSystem>
  mainFunctions!: Table<MainFunction>
  subFunctions!: Table<SubFunction>
  logSheetTemplates!: Table<LogSheetTemplate>
  logSheets!: Table<LogSheet>
  operationalUnits!: Table<OperationalUnit>

  // Version 6+
  fieldDefinitions!: Table<FieldDefinition>
  outbox!: Table<OutboxEntry>
  syncMeta!: Table<SyncMeta>
  logSheetUserArchives!: Table<LogSheetUserArchive>

  constructor() {
    super('offline-pwa-db')

    this.version(1).stores({
      records: '++id, localId, nfcTagId, syncStatus, createdAt, formType',
      assets: 'id, nfcTagId',
      settings: 'key'
    })

    this.version(2).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assets: null, // removed
      assetTypes: 'id, createdAt',
      assetEntries: 'id, nfcTagId, assetTypeId',
      settings: 'key'
    })

    this.version(3).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assetTypes: 'id, createdAt',
      assetEntries: 'id, nfcTagId, assetTypeId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, tagNumber, mainFunctionId, systemId, locationId',
      settings: 'key'
    })

    this.version(4).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assetTypes: 'id, createdAt',
      assetEntries: 'id, nfcTagId, assetTypeId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
      logSheetTemplates: 'id, scopeType, scopeId',
      logSheets: 'id, localId, templateId, status, createdAt',
      settings: 'key'
    })

    this.version(5)
      .stores({
        records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
        assetClasses: 'id, createdAt',
        assetTypes: null,
        assetEntries: 'id, nfcTagId, classId, subFunctionId',
        locations: 'id, code, parentId',
        plantSystems: 'id, code, locationId',
        mainFunctions: 'id, code, systemId, locationId',
        subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
        logSheetTemplates: 'id, scopeType, scopeId',
        logSheets: 'id, localId, serverId, templateId, status, createdAt',
        settings: 'key'
      })
      .upgrade(async (trans) => {
        try {
          const oldTypes = await trans.table('assetTypes').toArray()
          if (oldTypes.length > 0) await trans.table('assetClasses').bulkAdd(oldTypes)
        } catch { /* table may not exist */ }

        try {
          const entries = await trans.table('assetEntries').toArray()
          for (const entry of entries) {
            const raw = entry as Record<string, unknown>
            if (raw.assetTypeId && !raw.classId) {
              await trans.table('assetEntries').update(entry.id as string, { classId: raw.assetTypeId })
            }
          }
        } catch { /* no-op */ }
      })

    /**
     * Version 6 — Sync-readiness + dynamic field definitions.
     *
     * New tables:
     *   fieldDefinitions — normalized fields extracted from AssetClass.fields[]
     *   outbox           — durable change queue for the future push engine
     *   syncMeta         — stores lastSeq and other sync engine state
     *
     * Migration: AssetClass.fields[] → fieldDefinitions rows.
     * The original fields[] array is kept in assetClasses for backward compat
     * until all UI components switch to reading from fieldDefinitions.
     *
     * // SYNC ENGINE HOOK — outbox and syncMeta are the primary integration
     * //   points for src/services/sync/{push,pull}.ts
     */
    this.version(6)
      .stores({
        records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
        assetClasses: 'id, createdAt',
        assetEntries: 'id, nfcTagId, classId, subFunctionId',
        locations: 'id, code, parentId',
        plantSystems: 'id, code, locationId',
        mainFunctions: 'id, code, systemId, locationId',
        subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
        logSheetTemplates: 'id, scopeType, scopeId',
        logSheets: 'id, localId, serverId, templateId, status, createdAt',
        settings: 'key',
        // New in v6:
        fieldDefinitions: 'id, classId, order',
        outbox: 'id, entityType, synced, createdAt',
        syncMeta: 'key'
      })
      .upgrade(async (trans) => {
        // Seed syncMeta with lastSeq=null (first pull will start from 0)
        // SYNC ENGINE HOOK: pull engine reads 'lastSeq' to do incremental pulls
        await trans.table('syncMeta').put({ key: 'lastSeq', value: null })

        // Migrate AssetClass.fields[] → fieldDefinitions
        try {
          const classes = await trans.table('assetClasses').toArray()
          const defs: FieldDefinition[] = []
          const now = Date.now()

          for (const cls of classes) {
            const fields = ((cls as Record<string, unknown>).fields ?? []) as FormField[]
            fields.forEach((f, index) => {
              defs.push({
                id: uuidv4(),
                classId: cls.id as string,
                key: f.name,
                label: f.label,
                dataType: f.type as FieldDefinition['dataType'],
                unit: f.unit,
                required: f.required ?? false,
                validation: {
                  min: f.min,
                  max: f.max,
                  options: f.options,
                },
                order: index,
                createdAt: now,
                updatedAt: now,
                version: 1,
                deleted: false,
                synced: false,
              })
            })
          }

          if (defs.length > 0) {
            await trans.table('fieldDefinitions').bulkAdd(defs)
          }
        } catch {
          // Migration is best-effort; existing UI still reads from AssetClass.fields
        }
      })

    this.version(8).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assetClasses: 'id, createdAt',
      assetEntries: 'id, nfcTagId, classId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
      logSheetTemplates: 'id, scopeType, scopeId',
      logSheets: 'id, localId, serverId, templateId, status, createdAt',
      settings: 'key',
      fieldDefinitions: 'id, classId, order',
      outbox: 'id, entityType, synced, createdAt',
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId'
    })

    this.version(9).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assetClasses: 'id, createdAt',
      assetEntries: 'id, nfcTagId, classId, subFunctionId',
      locations: 'id, code, parentId',
      plantSystems: 'id, code, locationId',
      mainFunctions: 'id, code, systemId, locationId',
      subFunctions: 'id, code, tag, mainFunctionId, systemId, locationId',
      logSheetTemplates: 'id, scopeType, scopeId',
      logSheets: 'id, localId, serverId, templateId, status, createdAt',
      settings: 'key',
      fieldDefinitions: 'id, classId, order',
      outbox: 'id, entityType, synced, createdAt',
      syncMeta: 'key',
      operationalUnits: 'id, code, parentId',
      logSheetUserArchives: 'id, serverId, userId'
    })
  }
}

export const db = new AppDatabase()

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8081',
  syncIntervalMs: 30_000,
  operatorName: '',
  locationName: '',
  allowManualEntry: false
}
