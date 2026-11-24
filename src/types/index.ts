import type { AssetFieldOverrideSnapshot, FieldDefinition } from './sync'

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
  | 'signature'
  // Backend roadmap §31 Phase 2 — rendered by LookupFieldInput, never by DynamicFormField.
  | 'lookup'
  | 'lookupmulti'

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
  /** A choice field that accepts a typed answer outside `options` — `validation.allowCustom`. */
  allowCustom?: boolean
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
  /**
   * How long this tablet keeps its own copy of a round (backend roadmap §41). Server-owned,
   * delivered on bootstrap, never edited on the device.
   *
   * **Absent until a server has sent it**, and the absence is meaningful: the purge then runs on
   * the constants this app shipped with (`LEGACY_RETENTION` in `services/sync/deviceRetention.ts`),
   * so a newer app against an older server behaves exactly as before. There is deliberately no
   * default object in `DEFAULT_SETTINGS` — one would be indistinguishable from a value the server
   * chose.
   */
  deviceRetention?: DeviceRetentionPolicy
  /**
   * How long a signed-in session may keep working without any answer from the server before the
   * app locks and asks for the password again (backend V28). Server-owned, delivered on bootstrap,
   * never edited on the device. Absent until a server has sent it — and absent means never lock,
   * exactly the behaviour before this existed.
   */
  offlineSessionLimit?: OfflineSessionPolicy
}

/** The offline-session ceiling as the server sends it — see `services/auth/offlineSession.ts`. */
export interface OfflineSessionPolicy {
  /** Off means a session never locks for lack of contact. */
  enabled: boolean
  /** Hours since the server last answered this session. 8–720. */
  hours: number
}

/** The three server settings the local purge reads. Hours, as the panel shows them. */
export interface DeviceRetentionPolicy {
  /** A round the server accepted stays this long as history. 1–720. */
  syncedRetentionHours: number
  /**
   * Whether a round that never reached the server — refused by it, or a draft whose deadline
   * passed — is ever purged automatically. Off means never.
   */
  unsyncedPurgeEnabled: boolean
  /** Used only when `unsyncedPurgeEnabled` is on. 72–8760. */
  unsyncedRetentionHours: number
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

/**
 * How a round identifies its assets.
 *
 * `NONE` is not «scanning is broken» — it is a round where there is nothing to scan: a
 * questionnaire, an area inspection, a position nobody will ever label. The operator picks the
 * asset from the round's own list and the reading is recorded as a manual one, which is what it
 * is.
 */
export type AssetScanMode = 'NFC' | 'QR' | 'NFC_OR_QR' | 'NONE'

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
  /**
   * How this entry's current form data was captured. Unset means not yet filled.
   *
   * `'qr'` joined the pair when a round gained the ability to be identified by a QR code. It is
   * kept apart from `'nfc'` rather than folded in because the two carry different evidence: a
   * chip read can be checked against a hardware serial, a QR read has no serial to check, and a
   * report that merged them would overstate what half its rows prove.
   */
  filledVia?: 'nfc' | 'qr' | 'manual'
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
  /**
   * The operator who captured this file.
   *
   * **Media is not the sheet's, it is the person's.** Ownership used to be inferred from the
   * log sheet the row hangs off (`isAttachmentUploadableByUser` read `localOwnerUserId`), which
   * holds only while the sheet keeps the same owner. It does not survive a reassignment: the
   * local sheet row is **reused** — same `localId` — and a `reset-draft` empties its readings
   * without touching `db.attachments`. Every read path here keys on `logSheetLocalId`, so the
   * previous operator's photographs silently became the next one's:
   *
   * - the field's counter included them, so the new operator's field read «۳/۳» and refused a
   *   capture;
   * - `AttachmentFieldInput`'s orphan **adoption** wrote them into the new operator's own form
   *   value the moment the field was opened — displayed, submitted, and attributed to somebody
   *   who never took them;
   * - and deleting one from there queued a server-side delete, destroying the first operator's
   *   evidence.
   *
   * Meanwhile the first operator's archived snapshot is keyed by a synthetic
   * `archive:<serverId>:<userId>` id, so their own media was invisible to them.
   *
   * AGENTS.md says this invariant has to be applied to **every** outbound-syncable local table
   * separately and is not automatic. `logSheets` has `localOwnerUserId`, `nfcFaultReports` has
   * `createdByUserId`; this is the third table, and it is the one that was missed.
   *
   * Optional only for rows captured before this field existed — see `stampAttachmentOwners`,
   * which backfills them, and `isAttachmentOwnedByUser`, which falls back for anything the
   * backfill could not attribute.
   */
  createdByUserId?: string
  /**
   * Local id of the log sheet this media belongs to — **XOR with `formSubmissionLocalId`**.
   * Absent on form-owned rows (carrier 3). Still required for every log-sheet capture.
   */
  logSheetLocalId?: string
  /** Server id of the sheet — null until the sheet itself has one, which gates upload. */
  logSheetServerId?: string
  /**
   * Local id of the ad-hoc form submission this media belongs to — **XOR with `logSheetLocalId`**.
   * The server's attachment row carries `formSubmissionId` and a null `logSheetId`.
   */
  formSubmissionLocalId?: string
  /**
   * Server id of the form submission — null until the draft upsert lands, which gates upload
   * the same way `logSheetServerId` does for rounds.
   */
  formSubmissionId?: string
  /**
   * The asset this media belongs to, or **absent** when it answers the round's own question —
   * a question asked once for the whole sheet rather than once per asset.
   *
   * Optional rather than a second owner column, matching the server's `attachments.asset_id`
   * (V10): inside a log sheet there are exactly two owners media can have, and `logSheetLocalId`
   * is set either way, so absence carries the one bit that distinguishes them.
   *
   * It stays a plain Dexie index. An index simply does not list a row whose property is
   * undefined, and nothing queries `where('assetId')` — every read starts from the sheet and
   * filters in memory — so this needed no schema version bump.
   *
   * Form-owned media never has an asset — forms are flat, not per-asset.
   */
  assetId?: string
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
  /**
   * The id this file was first captured under, when the server answered that id
   * `409 ATTACHMENT_ID_TAKEN` (backend B-10, issue P-06): somebody else's file already holds it,
   * so the file was given this row's fresh id and its round's reference rewritten to match. Its
   * presence is also the «one re-mint per file» rule — a second collision parks the row.
   *
   * Plain, non-indexed property — needs no Dexie version bump.
   */
  idRemintedFrom?: string
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
   * Per-asset warning/danger overrides frozen with this sheet, keyed by **asset id as a
   * string** then by field key.
   *
   * A band belongs to a machine, not only to its class: two pumps of one class on one sheet
   * can legitimately be judged against different ranges. `fieldDefinitions` above cannot
   * express that — it is keyed by class — so the difference travels separately, and as a
   * *delta*: only the fields that actually differ from the class appear, because a 47-entry
   * sheet carrying whole definitions per asset would be ~135 KB instead of ~11 KB, on every
   * bundle fetch.
   *
   * `source` is the asset's mode when the sheet was raised (`RANGES_ONLY` or `FULL`) and
   * decides how far the override reaches — see `sheetFieldDefinitions`.
   *
   * Absent on sheets raised before the server grew this, and absent on any sheet where no
   * asset overrides anything, which is the overwhelming majority. Plain, non-indexed
   * property: no Dexie version bump.
   */
  fieldOverridesSnapshot?: Record<string, AssetFieldOverrideSnapshot>
  /**
   * The round's **own** questions, frozen with this sheet — asked once per sheet rather than
   * once per asset («آیا همه لوله‌ها بازدید شد؟»).
   *
   * Field definitions in every respect — same shape, same controls, same validator — with a
   * different owner, which is why `DynamicClassForm` renders them unchanged. They belong to no
   * asset class, so they are kept apart from `fieldDefinitions` rather than appended to it:
   * every per-asset path filters that list by `classId`, and a class-less entry in it would be
   * silently dropped by some and silently shown by others.
   *
   * Absent on a round that asks none, which is most of them. Plain, non-indexed property — no
   * Dexie version bump, the same as `fieldDefinitions` and `fieldOverridesSnapshot` above.
   */
  sheetFieldDefinitions?: FieldDefinition[]
  /**
   * The reference lists this round's lookup fields draw from, as its bundle declared them
   * (backend roadmap §31 Phase 2). The device keeps a list while any round still open on it needs
   * one, and drops it when none does — see services/lookups/lookupSync.ts.
   */
  requiredLookups?: Array<{ code: string; name: string; revision: number }>
  /** Answers to those questions, keyed by field key. */
  sheetFormData?: Record<string, unknown>
  /**
   * When the operator last answered them **on this device**.
   *
   * The sheet-level twin of `LogSheetEntryData.locallyEditedAt`, and it exists for exactly the
   * same reason: no question asked of `sheetFormData` can tell a value this device entered from
   * a value this device was sent, because after any sync the two are identical. Both predicates
   * that infer it from the data have already been tried at entry level and both lost real
   * readings — see `mapServerEntryToLocal`. So the opinion is recorded when it is formed, by
   * the save itself, and cleared when the server accepts it.
   */
  sheetFormLocallyEditedAt?: number
  /**
   * Server time (`savedAt`) of the accepted progress push that last carried this device's
   * answers to the round's questions.
   *
   * What lets a bundle merge recognise answers OLDER than the ones this device already
   * delivered: a bundle fetched just before that push landed and merged just after it — once the
   * marker above is cleared — would otherwise put the server's previous answers back on the
   * device. Server clock on both sides of the comparison (`ServerLogSheet.sheetFormUpdatedAt`).
   * Plain, non-indexed property — no Dexie version bump.
   */
  sheetFormDeliveredAt?: number

  /**
   * The server's verdict on every signature this round holds (backend roadmap §32), keyed
   * `"sheet:<fieldKey>"` / `"<assetId>:<fieldKey>"`, valued `VALID` / `STALE` / `NOT_BOUND` /
   * `UNVERIFIED` — replaced whole on every bundle merge. Only the server can judge a signature;
   * see `utils/signatureVerdict.ts`.
   *
   * Plain, non-indexed property — needs no Dexie version bump.
   */
  signatureStates?: Record<string, string>

  /**
   * Device-only fingerprints of what each VALID signature covered when it arrived, so an answer
   * changed on this tablet afterwards shows the signature as out of date before the next sync.
   * Never sent anywhere. Plain, non-indexed property — no Dexie version bump.
   */
  signatureBaselines?: Record<string, string>

  /**
   * How the operator must identify each asset on **this** round — frozen by the server when the
   * round was raised, so a template changed afterwards cannot change the rules under a tablet
   * that downloaded its bundle before the change.
   *
   * Absent means `'NFC'`: every round raised before the server grew this column was an NFC
   * round, and a bundle from an older server carries no such field. Plain, non-indexed property
   * — no Dexie version bump, like `sheetFieldDefinitions` beside it.
   */
  scanMode?: AssetScanMode
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
  /**
   * When the operator finished the round — **on the server's clock** as this device last measured
   * it (`serverNow()`, PWA roadmap §7), not the raw device clock. The server judges the deadline on
   * this value and refuses one lying in its own future (backend B-17).
   */
  completedAt?: number
  /**
   * The correction (server − device, ms) that went into `completedAt`, sent with the round as
   * evidence (`clientClockOffsetMs`). Absent on a round completed by an older build.
   */
  completionClockOffsetMs?: number
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
  /**
   * When the server answered a refused **submission** of this round with `kept: true` (backend
   * V25, issue P-02/B-01): it was not applied, but the server holds it as a void submission for
   * a supervisor to review. Absent means the readings exist only on this device — unless the
   * outcome is `SUPERSEDED`/`CANCELLED`, which the server has always kept. Plain, non-indexed
   * property: no Dexie version bump.
   */
  serverKeptAt?: number
  /**
   * When the server answered the last refused submission of this round with `kept: false`
   * (backend V26, issue B-04 §2): it declined to keep it, so the outcome's usual meaning —
   * `SUPERSEDED`/`CANCELLED` imply kept — does not hold, and the readings are only here.
   * Cleared whenever a later answer keeps it. Plain, non-indexed property: no Dexie version bump.
   */
  serverKeepRefusedAt?: number
  /**
   * Late progress (backend V25, issue P-01/B-02): readings of a draft whose deadline passed.
   *
   * The progress lane pushes such a draft **once per state of its markers**:
   * `lateProgressSentMarker` is the newest edit marker the last late push covered, answered
   * `EXPIRED` either way. `lateProgressKeptMarker` / `lateProgressKeptAt` are set only when that
   * answer said `kept: true` — the server holds those readings for the supervisor.
   *
   * **The edit markers themselves are deliberately not cleared on `kept`.** Kept is not applied:
   * if the supervisor extends the deadline, the next inbox/bundle merge carries the server's
   * values for these assets, which do not include the late readings, and only the markers make
   * this device's values win that merge. Cleared by an ordinary accepted push once the round is
   * open again — exactly as for any other progress.
   */
  lateProgressSentMarker?: number
  lateProgressKeptMarker?: number
  lateProgressKeptAt?: number
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

// ---------------------------------------------------------------------------
// Ad-hoc field forms (carrier 3) — separate from log sheets
// ---------------------------------------------------------------------------

/**
 * Server statuses for a form submission. Do not overload log-sheet IN_PROGRESS.
 *
 * `APPROVED` / `VOIDED` are forward-compatible with a future review/void API (not in V29).
 * Readers that mean «delivered / closed» must use `isCompletedFormServerStatus` so an
 * unhandled status does not leave a stale editable draft the way log-sheet APPROVED once did.
 */
export type FormSubmissionServerStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'VOIDED'

/** Delivered form submission — SUBMITTED or a later APPROVED review. */
export function isCompletedFormServerStatus(
  status?: FormSubmissionServerStatus | string | null
): boolean {
  return status === 'SUBMITTED' || status === 'APPROVED'
}

/** Maps a wire status into the known set; unknown future values are ignored (sync stays intact). */
export function coerceFormSubmissionServerStatus(
  raw?: string | null
): FormSubmissionServerStatus | undefined {
  if (raw == null) return undefined
  const s = String(raw).trim().toUpperCase()
  if (s === 'DRAFT' || s === 'SUBMITTED' || s === 'APPROVED' || s === 'VOIDED') return s
  return undefined
}

/**
 * A fillable form definition cached on the device so offline create still has a schema.
 *
 * Live fields apply only to a *new* draft; once a local draft exists its frozen
 * `fieldDefinitionsSnapshot` wins (server freezes on first draft save).
 */
export interface CachedFormDefinition {
  schemaVersionId?: string
  id: string
  code: string
  title: string
  description?: string | null
  active: boolean
  subjectUnitIds: string[]
  fields: FieldDefinition[]
  requiredLookups: Array<{ code: string; name: string; revision: number }>
  fetchedAt: number
}

/**
 * Local draft / final form submission — fourth outbound-owned table on a shared tablet.
 *
 * Two sync lanes (mirroring progress vs batch):
 * - `draftSyncStatus` — best-effort upsert; never writes `syncStatus` / `syncError`
 * - `syncStatus` — delivery of a final submit; counted in the pending badge
 */
export interface LocalFormSubmission {
  serverUpdatedAt?: number
  schemaVersionId?: string
  id: string
  /** Device-minted id; matches the server's `localId` for draft upsert / submit. */
  localId: string
  /** Server submission id once a draft upsert or submit has answered. */
  serverId?: string
  formDefinitionId: string
  formCode?: string
  formTitle?: string
  reporterUnitId: string
  subjectUnitId: string
  /** Local workflow: draft until the operator finalises; then submitted awaiting sync. */
  status: 'draft' | 'submitted'
  serverStatus?: FormSubmissionServerStatus
  formData: Record<string, unknown>
  /** Frozen on first local draft create / first server draft answer. */
  fieldDefinitionsSnapshot: FieldDefinition[]
  createdByUserId?: string
  /** Idempotency key for final submit — required by the server. */
  clientActionId?: string
  /** Optional key for draft upsert retries. */
  draftClientActionId?: string
  /** Final-submit queue (like log-sheet batch). */
  syncStatus: SyncStatus
  syncError?: string
  lastSubmitOutcome?: string
  /**
   * Draft-upsert queue (like progress). Never write final-submit fields from that lane.
   */
  draftSyncStatus?: SyncStatus
  draftSyncError?: string
  draftSyncedAt?: number
  /** Stamped on every local save so the draft lane knows the row is dirty. */
  locallyEditedAt?: number
  createdAt: number
  updatedAt: number
  submittedAt?: number
  syncedAt?: number
  deviceTimeAt?: number
}
