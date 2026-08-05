import Dexie, { type Table } from 'dexie'
import type { DataRecord, AssetClass, AssetEntry, AppSettings, Location, PlantSystem, MainFunction, SubFunction, LogSheetTemplate, LogSheet, LogSheetUserArchive, OperationalUnit, NfcFaultReport } from '@/types'
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

  // Version 10+
  nfcFaultReports!: Table<NfcFaultReport>

  constructor() {
    super('offline-pwa-db')

    /**
     * Single consolidated schema.
     *
     * Versions 1-10 were folded into this one block while the app is still
     * pre-production: they only ever *built up* to this shape, and their two
     * data migrations (assetTypes -> assetClasses in v5, AssetClass.fields ->
     * fieldDefinitions in v6) are meaningless on a fresh install and already
     * long since applied on any device that has been running the app.
     *
     * The version NUMBER is deliberately kept at 11 rather than reset to 1.
     * IndexedDB refuses to open a database whose on-disk version is higher
     * than the one requested, so renumbering downwards would hard-fail with a
     * VersionError on every device that already has the old database — the
     * user would have to clear site data by hand. Keeping 11 means existing
     * installs open unchanged and fresh installs create this shape directly.
     *
     * When the schema next changes, add a NEW `this.version(12).stores({...})`
     * below with the full store list; do not edit this block in place.
     */
    this.version(11).stores({
      records: '++id, localId, nfcTagId, syncStatus, recordStatus, createdAt',
      assetClasses: 'id, createdAt',
      assetEntries: 'id, nfcTagId, nfcSerial, classId, subFunctionId',
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
      logSheetUserArchives: 'id, serverId, userId',
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt'
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
