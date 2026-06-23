import { db, DEFAULT_SETTINGS } from './db'
import type { DataRecord, AssetType, AssetEntry, AppSettings, SyncStatus } from '@/types'
import { v4 as uuidv4 } from 'uuid'

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
// Asset Types
// ---------------------------------------------------------------------------

export async function getAllAssetTypes(): Promise<AssetType[]> {
  return db.assetTypes.orderBy('createdAt').toArray()
}

export async function getAssetType(id: string): Promise<AssetType | undefined> {
  return db.assetTypes.get(id)
}

export async function saveAssetType(
  data: Omit<AssetType, 'id' | 'createdAt' | 'updatedAt'>
): Promise<AssetType> {
  const now = Date.now()
  const assetType: AssetType = { ...data, id: uuidv4(), createdAt: now, updatedAt: now }
  await db.assetTypes.add(assetType)
  return assetType
}

export async function updateAssetType(
  id: string,
  updates: Partial<Omit<AssetType, 'id' | 'createdAt'>>
): Promise<void> {
  await db.assetTypes.update(id, { ...updates, updatedAt: Date.now() })
}

export async function deleteAssetType(id: string): Promise<void> {
  await db.assetTypes.delete(id)
}

// ---------------------------------------------------------------------------
// Asset Entries (NFC tag → asset type mapping)
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
