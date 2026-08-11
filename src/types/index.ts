import type { FieldDefinition } from './sync'

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

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

// Configured by admin — defines what fields to collect for a category of assets
export interface AssetClass {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

// Registered NFC tag mapped to an asset class
export interface AssetEntry {
  id: string
  nfcTagId: string
  /**
   * Physical NFC chip serial / UID, e.g. "00:aa:34:9f:12:cd". Optional — many assets have none.
   * Distinct from nfcTagId: the tag id is the logical lookup key (inherited from the sub-function
   * when the asset has none of its own), while this identifies the chip hardware itself.
   * Indexed in Dexie so a future scan-by-UID lookup needs no schema change.
   */
  nfcSerial?: string
  classId: string        // was assetTypeId
  assetName: string
  subFunctionId: string  // REQUIRED — link to SubFunction
  location?: string
  /**
   * The next four are sent by the server on every asset row (log-sheet bundle context and
   * the NFC lookup response both serialize the whole entity) and were simply missing from
   * this interface. Declared optional because nothing in the app requires them — they are
   * display-only, currently read by the admin NFC inspector.
   */
  assetCode?: string
  assetNameFa?: string
  active?: boolean
  description?: string
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

export type ScreenOrientationMode = 'auto' | 'portrait' | 'landscape'

export interface AppSettings {
  serverUrl: string
  syncIntervalMs: number
  allowManualEntry: boolean
  /**
   * When on, an NFC scan on the log-sheet fill page must match BOTH the Record 1
   * payload and the asset's stored chip serial. Off by default — the app's
   * original Record-1-only behaviour.
   */
  nfcStrictSerialMatch: boolean
  /**
   * How the app should sit on the device: follow rotation, or stay locked one way.
   *
   * A **device** preference, not an account one — it depends on how that particular tablet is
   * mounted — so it stays local and never syncs. Admin-only to change, like the NFC scan rule.
   */
  screenOrientation: ScreenOrientationMode
  /**
   * Attachment ceilings, owned by the server.
   *
   * Mirrored here so capture works offline, but **never edited on the device** — the Settings
   * screen shows them read-only to admins. They refresh on every bootstrap, so an administrator
   * changing them in the web panel reaches every tablet on its next reconnect.
   */
  attachmentLimits: AttachmentLimits
}

export interface AttachmentLimits {
  maxImagesPerField: number
  maxAudiosPerField: number
  maxVideosPerField: number
  maxAudioSeconds: number
  maxVideoSeconds: number
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
  /** Physical NFC chip serial (UID) snapshot from the server; display/scan-matching only. */
  nfcSerial?: string
  classId: string          // was assetTypeId
  formData: Record<string, unknown>  // filled by operator
  /** Device time when form data was first saved (epoch millis). */
  createdAt?: number
  /** Device time of the latest edit (epoch millis). */
  updatedAt?: number
  /** How this entry's current form data was captured. Unset means not yet filled. */
  filledVia?: 'nfc' | 'manual'
}

/** What an image/audio field stores in formData — ids only, never bytes. */
export interface AttachmentRef {
  type: 'attachment'
  ids: string[]
}

export type AttachmentKind = 'IMAGE' | 'AUDIO' | 'VIDEO'

/**
 * An attachment held on this device.
 *
 * The `blob` is the compressed media itself. It is dropped once the file is safely on the
 * server (`syncStatus === 'synced'`) and the retention window passes — the row stays so the
 * UI can still describe the attachment and fetch it on demand when online.
 */
export interface LocalAttachment {
  /** UUID minted here. It is also the server's primary key, which is what makes upload idempotent. */
  id: string
  logSheetLocalId: string
  /** Server id of the sheet — null until the sheet itself has one, which gates upload. */
  logSheetServerId?: string
  assetId: string
  fieldKey: string
  kind: AttachmentKind
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationMs?: number
  /** Dropped after upload + retention; absent means "on the server only". */
  blob?: Blob
  syncStatus: SyncStatus
  syncError?: string
  /**
   * True when the server refused this file in a way retrying cannot fix (a 4xx other than
   * 401/408). Such a row is parked: it stays visible with its reason, but the upload queue
   * stops picking it up. Without this flag a permanently rejected file would be re-sent on
   * every sync pass forever, burning a field tablet's battery and data to no purpose.
   *
   * Plain, non-indexed property — needs no Dexie version bump.
   */
  permanentFailure?: boolean
  createdAt: number
  uploadedAt?: number
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
  /**
   * Field definitions frozen with this sheet, exactly as its bundle delivered them.
   *
   * The server derives a bundle's definitions from that sheet's own
   * `field_definitions_snapshot`, so two sheets of the same asset class can legitimately
   * carry different schemas when the class was edited between their generation dates.
   * Keeping the copy on the sheet is what makes each sheet render the schema it was raised
   * with; the shared `fieldDefinitions` table is only a fallback for sheets stored before
   * this field existed. Stored as a plain property — it is never queried by index, so it
   * needs no Dexie schema change.
   */
  fieldDefinitions?: FieldDefinition[]
  /**
   * The server's outcome for the last rejected submission (e.g. `VALIDATION_ERROR`).
   *
   * Only a rejection sets this, and only `VALIDATION_ERROR` unlocks the correct-and-resubmit
   * path — an operator can fix bad values, but not a sheet deleted server-side or an asset
   * mismatch. Cleared whenever the sheet goes back to draft or syncs. Plain, non-indexed
   * property: no Dexie version bump.
   */
  lastSubmitOutcome?: string
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
