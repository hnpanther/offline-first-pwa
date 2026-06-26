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
  assetTypeId?: string   // legacy field — keep as-is
  recordStatus: RecordStatus
  formData: Record<string, unknown>
  notes?: string
  operatorName?: string
  location?: string
}

// Configured by admin — defines what fields to collect for a category of assets
export interface AssetClass {
  id: string
  name: string
  fields: FormField[]
  createdAt: number
  updatedAt: number
}

// Registered NFC tag mapped to an asset class
export interface AssetEntry {
  id: string
  nfcTagId: string
  classId: string        // was assetTypeId
  assetName: string
  subFunctionId: string  // REQUIRED — link to SubFunction
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

// ---------------------------------------------------------------------------
// Hierarchy entities
// ---------------------------------------------------------------------------

export interface Location {
  id: string
  code: string
  name: string
  parentId?: string   // for sub-locations
  createdAt: number
  updatedAt: number
}

export interface PlantSystem {
  id: string
  code: string
  name: string
  locationId: string
  createdAt: number
  updatedAt: number
}

export interface MainFunction {
  id: string
  code: string
  name: string
  systemId?: string
  locationId?: string
  createdAt: number
  updatedAt: number
}

export interface SubFunction {
  id: string
  code: string      // functional code e.g. "SF-001"
  name: string      // descriptive name
  tag: string       // physical tag number (was tagNumber)
  mainFunctionId?: string
  systemId?: string
  locationId?: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Log Sheet entities
// ---------------------------------------------------------------------------

export interface LogSheetTemplate {
  id: string
  name: string
  description?: string
  scopeType: 'location' | 'system' | 'mainFunction'
  scopeId: string
  createdAt: number
  updatedAt: number
}

export interface LogSheetEntryData {
  assetId: string
  assetName: string
  subFunctionCode: string
  subFunctionTag: string
  classId: string          // was assetTypeId
  formData: Record<string, unknown>  // filled by operator
}

export interface LogSheet {
  id: string
  localId: string
  templateId: string
  templateName: string
  scopeSummary: string    // e.g. "واحد 01 / سیستم شیرین‌سازی"
  operatorName?: string
  status: 'draft' | 'submitted'
  syncStatus: SyncStatus
  syncedAt?: number
  syncError?: string
  serverId?: string
  entries: LogSheetEntryData[]
  submittedAt?: number
  createdAt: number
  updatedAt: number
}
