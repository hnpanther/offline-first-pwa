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

export interface OperationalUnit {
  id: string
  code: string
  name: string
  parentId?: string
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
  classId?: string
  operationalUnitId?: string
  createdAt: number
  updatedAt: number
}

export type LogSheetServerStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'VOIDED'
  | 'EXPIRED'
  | 'CANCELLED'

export type LogSheetAssignmentType = 'SELF_CLAIMED' | 'SUPERVISOR_ASSIGNED'

export interface LogSheetEntryData {
  assetId: string
  assetName: string
  subFunctionCode: string
  subFunctionTag: string
  nfcTagId?: string
  classId: string          // was assetTypeId
  formData: Record<string, unknown>  // filled by operator
  /** Device time when form data was first saved (epoch millis). */
  createdAt?: number
  /** Device time of the latest edit (epoch millis). */
  updatedAt?: number
  /** How this entry's current form data was captured. Unset means not yet filled. */
  filledVia?: 'nfc' | 'manual'
}

export interface LogSheet {
  id: string
  localId: string
  serverId?: string
  templateId: string
  templateName: string
  scopeSummary: string
  /** Human-readable scope from server bundle (offline-friendly). */
  scopeDisplayLabel?: string
  operationalUnitId?: string
  operatorName?: string
  /** Server assignee user id — used to isolate sheets between logins on a shared device. */
  assigneeUserId?: string
  /** Device session user who entered/submitted local work (shared-tablet isolation). */
  localOwnerUserId?: string
  /** Local workflow: draft = in progress on device, submitted = ready to sync */
  status: 'draft' | 'submitted'
  /** Server lifecycle status from last inbox/claim sync */
  serverStatus?: LogSheetServerStatus
  assignmentType?: LogSheetAssignmentType
  dueAt?: number
  syncStatus: SyncStatus
  syncedAt?: number
  syncError?: string
  entries: LogSheetEntryData[]
  submittedAt?: number
  completedAt?: number
  clientActionId?: string
  createdAt: number
  updatedAt: number
}

/** Frozen copy of a log sheet for one user on a shared tablet (key: serverId:userId). */
export interface LogSheetUserArchive {
  id: string
  serverId: string
  userId: string
  sheet: LogSheet
  archivedAt: number
}

// ---------------------------------------------------------------------------
// NFC fault reports
// ---------------------------------------------------------------------------

/**
 * A reported NFC scan failure for one asset within one log sheet (tag missing,
 * broken, or the device's NFC hardware itself unusable). Its presence for a
 * given (logSheetServerId, assetId) pair unlocks the manual-entry fallback for
 * that asset. Insert-only — never edited or deleted from the PWA.
 */
export interface NfcFaultReport {
  /** Local id, also used as the mobile batch payload's localId. */
  id: string
  logSheetServerId: string
  assetId: string
  reason?: string
  reportedByName?: string
  source: 'MOBILE'
  createdAt: number
  syncStatus: SyncStatus
  syncedAt?: number
  syncError?: string
  serverId?: string
  clientActionId: string
  /**
   * Session user id that filed this report locally. Local-only — never sent to the
   * server, which derives the real submitter from the authenticated session at sync
   * time. Used to keep a pending report from being uploaded under a different user's
   * session after a login switch on a shared device. Absent on records created before
   * this field existed; treated as owned by whoever is currently logged in.
   */
  createdByUserId?: string
}
