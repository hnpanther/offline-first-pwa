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

/**
 * What {@link FormField.type} may hold — the same set as the wire's `FieldDataType`.
 *
 * <p>`toFormField` copies a field definition's `dataType` straight into this, so the two must
 * match or that assignment stops compiling. `DynamicFormField` only draws the scalar cases and
 * falls through to a disabled "نوع فیلد پشتیبانی نمی‌شود" box for the rest — which is correct, because
 * `DynamicClassForm` routes media and location fields to their own inputs before reaching it.
 */
export type FormFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'textarea'
  | 'image'
  | 'audio'
  | 'video'
  | 'location'

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
  /**
   * When on, an NFC scan on the log-sheet fill page must match BOTH the Record 1 payload and
   * the asset's stored chip serial.
   *
   * **Server-owned and no longer editable anywhere** — not on the device, not in the web panel.
   * Record 1 alone can be copied onto a blank tag, so the serial is the only part of a scan
   * that means "I stood in front of this equipment"; that is an integrity rule rather than a
   * preference, and it now ships from `app.nfc.strict-serial-match` on every bootstrap. The
   * value here is a mirror kept so scanning still works offline.
   */
  nfcStrictSerialMatch: boolean
  /**
   * Site-wide switch above the manual-tag-entry permission, owned by the server.
   *
   * **An AND with the operator's own permission, never an OR.** Off means nobody may type a tag
   * id however privileged, and an asset can only be opened by scanning it or through an NFC fault
   * report. An earlier device-side switch of the same name did the opposite — it *granted* manual
   * entry to everyone who could reach the tablet's Settings screen — which is exactly why this one
   * arrives from the server and only ever restricts.
   */
  nfcManualEntryEnabled: boolean
  /**
   * Whether the camera flow offers the annotate-before-save step. Server-owned like the
   * ceilings below, admin-editable in the web panel. Off reproduces the original capture path
   * exactly: the photo is compressed and stored with no extra step.
   */
  imageAnnotationEnabled: boolean
  /**
   * How the app should sit on the device: follow rotation, or stay locked one way.
   *
   * A **device** preference, not an account one — it depends on how that particular tablet is
   * mounted — so it stays local and never syncs. Admin-only to change.
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
  /**
   * A supervisor reviewed the completed round and accepted it.
   *
   * **Treat it exactly as `SUBMITTED` everywhere on this device.** Approval is a review laid on
   * top of completion, not a different kind of completion: the round is delivered, the server
   * owns it, and nothing here may behave differently. The one place that mattered is
   * `alignLocalWorkflowWithServer` — an unhandled status falls through to "not open", which
   * returns null and leaves a stale local draft alive and editable for a sheet the server has
   * closed. The operator then submits it, the server voids it as superseded, and from their
   * side the work vanished.
   */
  | 'APPROVED'
  | 'VOIDED'
  | 'EXPIRED'
  | 'CANCELLED'

/**
 * Whether the server considers this round delivered.
 *
 * The client-side twin of the backend's `LogSheetStatus.COMPLETED_STATUSES`. Every check that
 * used to read `serverStatus === 'SUBMITTED'` has to go through this, for the reason spelled out
 * on `'APPROVED'` above.
 */
export function isCompletedServerStatus(status?: LogSheetServerStatus | null): boolean {
  return status === 'SUBMITTED' || status === 'APPROVED'
}

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
  /**
   * Device time of the last save an operator made to this entry **on this device**, whether
   * they entered a value or removed the last one. Local-only: never sent to the server, never
   * returned by it.
   *
   * It exists because "this device has an opinion about this asset" cannot be inferred from
   * `formData`, and both attempts to infer it failed in production. Key presence
   * (`Object.keys(formData).length > 0`) counted a blank the web form had written as work, which
   * is how a supervisor's readings became invisible on log sheet 85. Value presence
   * (`hasEntryFormData`) counts a *deliberate clear* as no opinion, so the next bundle refresh
   * put the old server value back and the operator's deletion vanished before they could submit.
   * Only an explicit marker distinguishes "untouched" from "emptied on purpose".
   *
   * **It must be cleared once the work has been delivered** — see `clearLocalEditMarkers`. A
   * marker that outlives its submission makes the device win that entry forever, which is the
   * log sheet 85 bug again by another route.
   *
   * Deliberately *not* expressed by bumping `updatedAt` on a clearing save: `createdAt` and
   * `updatedAt` are echoed to the server as the base this device last saw, and the server's
   * `wouldBlankUnseenAnswer` compares them for equality. Moving them on a clear would make the
   * server refuse every deliberate clear.
   */
  locallyEditedAt?: number
  /**
   * Who recorded the values currently stored for this asset, as a display name.
   *
   * Server-resolved and server-authoritative. It exists for the reopen-and-reassign case: a
   * supervisor reopens a submitted sheet and hands it to a second operator to redo part of it,
   * and that operator opens a form already full of readings. Without a name they cannot tell
   * which rows are their own work and which are the previous operator's — so they either redo
   * everything or trust values they have never seen taken.
   *
   * The server only re-attributes an entry when its value actually changes, so this keeps
   * naming the original operator until somebody edits that asset. Unset means nobody has
   * filled it yet.
   */
  filledByName?: string
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
  /**
   * The HTTP status behind the last refusal.
   *
   * `syncError` holds the backend's own translated sentence, so it can be shown but never
   * classified. This can: it distinguishes a row parked because the wrong operator was signed in
   * on a shared tablet (**403** — true only while they were) from one holding a file the server
   * will always refuse (400, 422). Absent on rows parked before this field existed, which is
   * itself meaningful — see `shouldReviveParkedAttachment`.
   *
   * Plain, non-indexed property — needs no Dexie version bump.
   */
  failedStatus?: number
  /**
   * The operator removed this file, the server still has it, and the deletion has not been
   * delivered yet.
   *
   * Every read path filters these out, so the file is gone from the operator's point of view
   * immediately — the row lingers only so the sync pass can tell the server too. It exists
   * because a delete has to survive being made offline: dropping the row on the spot leaves the
   * server copy behind forever, and the server counts its own copies against the per-field
   * ceiling, so each such orphan permanently consumes a slot the operator can see is free.
   *
   * Plain, non-indexed property — needs no Dexie version bump.
   */
  pendingDelete?: boolean
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
  /**
   * Whether this device still owes the server a progress report for this round.
   *
   * A **separate queue from `syncStatus`**, and the separation is the whole design. `syncStatus`
   * tracks the delivery of finished work and drives the pending badge; this tracks a live report
   * about work still in progress, which is best-effort by nature. A refused progress push must
   * never be able to mark real, undelivered readings as failed, and it cannot if the two never
   * share a field.
   *
   * Set to `'pending'` by every operator save, cleared to `'synced'` when the server accepts the
   * push. Plain, non-indexed property — no Dexie version bump.
   */
  progressSyncStatus?: SyncStatus
  /** Server time of the last accepted progress push — what «آخرین همگام‌سازی پیشرفت» shows. */
  progressSyncedAt?: number
  /** Why the last progress push was refused, for the fill page. Never shown as a sync failure. */
  progressError?: string
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
