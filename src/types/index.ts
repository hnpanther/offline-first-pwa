export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'
export type RecordStatus = 'draft' | 'approved'

export interface BaseRecord {
  id?: number
  localId: string
  createdAt: number
  updatedAt: number
  syncStatus: SyncStatus
  syncedAt?: number
  syncError?: string
  serverId?: string
}

export interface NFCTagData {
  serialNumber: string
  message?: string
  records?: NFCRecord[]
  rawData?: unknown
}

export interface NFCRecord {
  recordType: string
  mediaType?: string
  data?: string
}

export interface DataRecord extends BaseRecord {
  nfcTagId: string
  assetEntryId?: string
  assetName?: string
  assetTypeId?: string
  recordStatus: RecordStatus
  formData: Record<string, unknown>
  notes?: string
  operatorName?: string
  location?: string
}

// Configured by admin — defines what fields to collect for a category of assets
export interface AssetType {
  id: string
  name: string
  fields: FormField[]
  createdAt: number
  updatedAt: number
}

// Registered NFC tag mapped to an asset type
export interface AssetEntry {
  id: string
  nfcTagId: string
  assetTypeId: string
  assetName: string
  location?: string
  createdAt: number
  updatedAt: number
}

export type FormFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'textarea'

export interface FormFieldOption {
  value: string
  label: string
}

export interface FormField {
  name: string
  label: string
  type: FormFieldType
  required?: boolean
  placeholder?: string
  options?: FormFieldOption[]
  min?: number
  max?: number
  unit?: string
  defaultValue?: unknown
  helperText?: string
}

export interface SyncState {
  isOnline: boolean
  isSyncing: boolean
  lastSyncAt?: number
  pendingCount: number
  failedCount: number
  error?: string
}

export interface AppSettings {
  serverUrl: string
  syncIntervalMs: number
  operatorName: string
  locationName: string
  allowManualEntry: boolean
}

export interface NFCScanResult {
  success: boolean
  tagData?: NFCTagData
  error?: string
}
