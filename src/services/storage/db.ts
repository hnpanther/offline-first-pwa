import Dexie, { type Table } from 'dexie'
import type { AssetClass, AssetEntry, AppSettings, Location, PlantSystem, MainFunction, SubFunction, LogSheetTemplate, LogSheet, LogSheetUserArchive, OperationalUnit, NfcFaultReport, LocalAttachment } from '@/types'
import type { FieldDefinition, OutboxEntry, SyncMeta } from '@/types/sync'

const DB_NAME = 'offline-pwa-db'

class AppDatabase extends Dexie {
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
  fieldDefinitions!: Table<FieldDefinition>
  outbox!: Table<OutboxEntry>
  syncMeta!: Table<SyncMeta>
  logSheetUserArchives!: Table<LogSheetUserArchive>
  nfcFaultReports!: Table<NfcFaultReport>
  attachments!: Table<LocalAttachment>

  constructor() {
    super(DB_NAME)

    /**
     * The one and only schema version.
     *
     * The app has never shipped, so the eleven historical versions that only ever
     * built up to this shape were collapsed into a single `version(1)` — the same
     * reasoning as folding the backend's Flyway migrations into V1. There is no
     * upgrade path to preserve because there is no production data to upgrade.
     *
     * A device that still holds the pre-collapse database is on IndexedDB version
     * 110 and cannot be opened by a version(1) declaration — IndexedDB refuses to
     * "downgrade". `openDatabase()` below catches exactly that and recreates the
     * database from scratch, which is safe here: every table is either server-owned
     * reference data that the next sync refetches, or local work that a pre-production
     * dev device can afford to lose.
     *
     * When the schema next changes, add `this.version(2).stores({...})` below with the
     * full store list rather than editing this block.
     */
    this.version(1).stores({
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

    /**
     * v2 — attachments (photos / voice notes).
     *
     * Added as a new version rather than by editing v1, per the rule above: v1 has shipped to
     * dev devices, and rewriting it would make their on-disk version un-openable. This is a
     * pure additive store with no `.upgrade()` callback, which is safe precisely because no
     * existing data is reshaped — every v1 store is repeated verbatim, as Dexie requires.
     *
     * `syncStatus` is indexed because the upload queue selects on it every tick; `blob` is not
     * indexed (IndexedDB cannot index a Blob, and nothing queries by content).
     */
    this.version(2).stores({
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
      nfcFaultReports: 'id, logSheetServerId, assetId, syncStatus, createdAt',
      attachments: 'id, logSheetLocalId, logSheetServerId, assetId, fieldKey, syncStatus, createdAt'
    })
  }
}

export const db = new AppDatabase()

/**
 * Opens the database, recreating it if the on-disk version is newer than this build.
 *
 * Only reachable on a dev device that ran the app before the version numbers were
 * collapsed to 1. Dexie surfaces that as `VersionError`; the only way forward is to
 * delete and recreate, since IndexedDB cannot open a database at a lower version than
 * it was created with. Any other failure is rethrown untouched — silently wiping a
 * user's database on an unrelated error would be far worse than failing loudly.
 */
export async function openDatabase(): Promise<void> {
  try {
    await db.open()
  } catch (err) {
    if ((err as Error)?.name !== 'VersionError') throw err
    db.close()
    await Dexie.delete(DB_NAME)
    await db.open()
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8081',
  syncIntervalMs: 30_000,
  // Both of the next two are server-owned: bootstrap overwrites them on every reconnect and
  // nothing on the device may edit them. These values are what the app runs on until the first
  // bootstrap of a fresh install lands, so each one deliberately matches the server's own
  // default — a device must never start out on a *weaker* rule than the plant's.
  nfcStrictSerialMatch: true,
  imageAnnotationEnabled: true,
  // Follow the device unless someone deliberately pins it. Auto is the only default that is
  // right everywhere: a locked orientation on a device mounted the other way round is worse
  // than no preference at all.
  screenOrientation: 'auto',
  // Mirrors the server's own defaults. Used until the first bootstrap lands, and after that
  // only as the fallback for a server too old to send them.
  attachmentLimits: {
    maxImagesPerField: 3,
    maxAudiosPerField: 1,
    maxVideosPerField: 1,
    maxAudioSeconds: 120,
    maxVideoSeconds: 120
  }
}
