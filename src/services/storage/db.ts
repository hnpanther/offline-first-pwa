import Dexie, { type Table } from 'dexie'
import type { DataRecord, AssetType, AssetEntry, AppSettings } from '@/types'

class AppDatabase extends Dexie {
  records!: Table<DataRecord>
  assetTypes!: Table<AssetType>
  assetEntries!: Table<AssetEntry>
  settings!: Table<AppSettings & { key: string }>

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
  }
}

export const db = new AppDatabase()

export const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: 'http://localhost:3000',
  syncIntervalMs: 30_000,
  operatorName: '',
  locationName: '',
  allowManualEntry: false
}
