/**
 * ALL server API calls are defined here.
 * UI components, hooks, and sync services import only from this file.
 * Never import apiClient directly outside this module.
 *
 * Endpoint groups:
 *   - Health
 *   - Bootstrap (light user + operational units)
 *   - Log sheet bundles (per-sheet reference data)
 *   - Asset lookup (NFC scan → asset info)
 *   - Log sheets (push submitted log sheets)
 */

import { apiClient, ApiError } from './client'
import type {
  AssetClass,
  AssetEntry,
  AssetScanMode,
  Location,
  PlantSystem,
  MainFunction,
  SubFunction,
  LogSheetServerStatus,
  LogSheetAssignmentType,
  OperationalUnit
} from '@/types'
import type { AssetFieldOverrideSnapshot, FieldDefinition } from '@/types/sync'
import type { LoginRequest, LoginResponse } from '@/types/auth'
import type { EnrollmentStateResponse, LoginChallengeResponse, WipeConfirmedResponse } from '@/types/device'
import { measuredRequest } from '@/services/clock/serverClock'

// ===========================================================================
// Health
// ===========================================================================

export async function login(
  credentials: LoginRequest,
  signal?: AbortSignal
): Promise<LoginResponse> {
  // Measured: a server from V28 on says its time in the answer, which sets this device's clock
  // correction from the first moment of a session (PWA roadmap §7). An older server says nothing,
  // and nothing is recorded.
  return measuredRequest(() => apiClient.post<LoginResponse>('/api/auth/login', credentials, signal, false))
}

// ===========================================================================
// Device enrolment — all unauthenticated: the device asking is not yet trusted
// ===========================================================================

/** A nonce to sign at login, or `{enforced: false}` when the server does not enrol devices. */
export async function fetchLoginChallenge(
  deviceId: number,
  keyFingerprint: string,
  signal?: AbortSignal
): Promise<LoginChallengeResponse> {
  return apiClient.post<LoginChallengeResponse>(
    '/api/auth/challenge',
    { deviceId, keyFingerprint },
    signal,
    false
  )
}

export async function requestDeviceEnrollment(
  publicKey: string,
  label: string | undefined,
  signal?: AbortSignal
): Promise<EnrollmentStateResponse> {
  return apiClient.post<EnrollmentStateResponse>(
    '/api/devices/enrollment-requests',
    { publicKey, label },
    signal,
    false
  )
}

export async function confirmDeviceEnrollment(
  requestId: number,
  enrollmentCode: string,
  signature: string,
  signal?: AbortSignal
): Promise<EnrollmentStateResponse> {
  // The id travels in the body, not the path: this endpoint is unauthenticated and must be on the
  // server's exact-match list of pre-authentication paths, which a path variable cannot be.
  return apiClient.post<EnrollmentStateResponse>(
    '/api/devices/enrollment-requests/confirm',
    { requestId, enrollmentCode, signature },
    signal,
    false
  )
}

/**
 * A revoked device confirming it has deleted its data (backend V28, wipe on revoke). Signed with
 * this device's key over `wipeMessage(deviceId, wipeOrderedAt)`; unauthenticated, because the
 * revoke ended every session. Under the enrolment prefix so the nginx rate limit already covers it.
 */
export async function confirmDeviceWipe(
  deviceId: number,
  wipeOrderedAt: number,
  signature: string,
  signal?: AbortSignal
): Promise<WipeConfirmedResponse> {
  return apiClient.post<WipeConfirmedResponse>(
    '/api/devices/enrollment-requests/wipe-confirm',
    { deviceId, wipeOrderedAt, signature },
    signal,
    false
  )
}

// ===========================================================================
// Log sheet inbox (kartabl)
// ===========================================================================

/** Server log sheet shape returned by inbox / claim / release. */
export interface ServerLogSheet {
  id: number
  localId?: string | null
  templateId?: number | null
  templateName?: string | null
  scopeSummary?: string | null
  operationalUnitId?: number | null
  status?: LogSheetServerStatus | null
  origin?: string | null
  assigneeUserId?: number | null
  assignmentType?: LogSheetAssignmentType | null
  assignedByUserId?: number | null
  completedByUserId?: number | null
  operatorName?: string | null
  dueAt?: number | null
  assignedAt?: number | null
  claimedAt?: number | null
  startedAt?: number | null
  completedAt?: number | null
  expiredAt?: number | null
  submittedAt?: number | null
  syncedAt?: number | null
  draftSavedAt?: number | null
  syncStatus?: string | null
  syncError?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  /**
   * Per-asset field overrides frozen onto this sheet, keyed by asset id as a string.
   *
   * The server has always sent it — it is a column on the sheet entity the bundle serialises
   * whole — but nothing here declared it, so `applyLogSheetBundle` never copied it onto the
   * stored record and `sheetFieldDefinitions` found `undefined` on every sheet. The device
   * therefore drew every asset against its class's bands, which is the defect the column
   * exists to remove.
   */
  fieldOverridesSnapshot?: Record<string, AssetFieldOverrideSnapshot> | null
  /**
   * The round's OWN questions, frozen when this sheet was raised — asked once per sheet rather
   * than once per asset.
   *
   * Like `fieldOverridesSnapshot` above, this needed nothing new on the wire: the bundle
   * serialises the whole sheet entity, so both this and `sheetFormData` have travelled since
   * the server grew them. Declaring them is what lets the merge copy them onto the stored row.
   */
  /**
   * How this round identifies its assets — `NFC`, `QR`, `NFC_OR_QR` or `NONE`, frozen by the
   * server when the round was raised. Absent from a server older than that column, which the
   * device reads as `NFC`.
   */
  scanMode?: AssetScanMode | null
  sheetFieldDefinitionsSnapshot?: FieldDefinition[] | null
  /** The answers to those questions, keyed by field key. Null when nobody has answered. */
  sheetFormData?: Record<string, unknown> | null
  /**
   * Server time the answers last changed (`log_sheets.sheet_form_updated_at`) — on the wire since
   * V9, declared so a merge can tell answers older than this device's last delivery from newer
   * ones (`LogSheet.sheetFormDeliveredAt`).
   */
  sheetFormUpdatedAt?: number | null
}

/** Server-generated rows for a log sheet (authoritative asset list). */
export interface ServerLogSheetEntry {
  assetId: number
  assetName?: string | null
  subFunctionCode?: string | null
  subFunctionTag?: string | null
  nfcTagId?: string | null
  /** Physical NFC chip serial (UID) snapshot, e.g. "00:aa:34:9f:12:cd". Optional. */
  nfcSerial?: string | null
  classId?: number | null
  formData?: Record<string, unknown> | null
  createdAt?: number | null
  updatedAt?: number | null
  /**
   * Display name of whoever last recorded this entry's values.
   *
   * Resolved on the server: the device holds no user directory and a round is filled offline
   * where it could not fetch one. The bundle has always carried `filledByUserId`, which names
   * nobody — this is the value the fill screen can actually show.
   */
  filledByName?: string | null
}

export interface LogSheetContextDto {
  locations?: Location[]
  plantSystems?: PlantSystem[]
  mainFunctions?: MainFunction[]
  subFunctions?: SubFunction[]
  assetEntries?: AssetEntry[]
  assetClasses?: AssetClass[]
  fieldDefinitions?: FieldDefinition[]
  scopeDisplayLabel?: string | null
  /**
   * The round's own questions, resolved by the server exactly as its fill page resolves them.
   * Present from the server that added it; an older server sends only the sheet's
   * `sheetFieldDefinitionsSnapshot`, which is null on a custom sheet until its first answer.
   */
  sheetFieldDefinitions?: FieldDefinition[]
  /**
   * The reference lists this round's lookup fields draw from, with the revision each stands at
   * (backend roadmap §31 Phase 2). The items never travel in a bundle — they arrive once per
   * device through `GET /api/lookups/{code}/items` (services/lookups/lookupSync.ts).
   */
  requiredLookups?: RequiredLookup[]
}

/** One list a round needs on the device. `code` is the list's identity; `revision` its version. */
export interface RequiredLookup {
  code: string
  name: string
  revision: number
}

/** One page of a reference list for a device — `GET /api/lookups/{code}/items`. */
export interface LookupDevicePage {
  code: string
  name: string
  revision: number
  serverTime: number
  leaseUntil: number
  columns: Array<{ key: string; label: string; searchable: boolean; display: boolean }>
  items: Array<{
    id: number
    code: string
    label: string
    active: boolean
    attributes: Record<string, string>
    parentCode?: string | null
    updatedAt: number
  }>
  hasMore: boolean
  nextSince: number
  nextAfterId: number
}

/** Self-contained server payload for one log sheet (metadata + entries + scoped context). */
export interface LogSheetBundleDto {
  sheet: ServerLogSheet
  entries: ServerLogSheetEntry[]
  context: LogSheetContextDto | null
  /**
   * The server's verdict on each signature on this round (backend roadmap §32) — see
   * `LogSheet.signatureStates`. Absent from an older server.
   */
  signatureStates?: Record<string, string>
}

export interface LogSheetInboxResponse {
  serverTime: number
  assigned: LogSheetBundleDto[]
  available: ServerLogSheet[]
  teamOpen?: ServerLogSheet[]
}

export async function fetchLogSheetInbox(
  signal?: AbortSignal
): Promise<LogSheetInboxResponse> {
  return measuredRequest(() => apiClient.get<LogSheetInboxResponse>('/api/log-sheets/inbox', signal))
}

export async function fetchLogSheetBundle(
  serverId: number | string,
  signal?: AbortSignal
): Promise<LogSheetBundleDto> {
  return apiClient.get<LogSheetBundleDto>(`/api/log-sheets/${serverId}/bundle`, signal)
}

/**
 * One page of a reference list (backend roadmap §31 Phase 2). Refused with 403 when no open round
 * assigned to this user draws from the list — the caller then drops its copy.
 */
export async function fetchLookupPage(
  code: string,
  since: number,
  afterId: number,
  limit: number,
  signal?: AbortSignal
): Promise<LookupDevicePage> {
  const query = `since=${encodeURIComponent(String(since))}&afterId=${encodeURIComponent(String(afterId))}&limit=${limit}`
  return apiClient.get<LookupDevicePage>(`/api/lookups/${encodeURIComponent(code)}/items?${query}`, signal)
}

export async function claimLogSheet(
  serverId: number | string,
  signal?: AbortSignal
): Promise<LogSheetBundleDto> {
  return apiClient.post<LogSheetBundleDto>(
    `/api/log-sheets/${serverId}/claim`,
    {},
    signal
  )
}

export async function releaseLogSheet(
  serverId: number | string,
  signal?: AbortSignal
): Promise<ServerLogSheet> {
  return apiClient.post<ServerLogSheet>(
    `/api/log-sheets/${serverId}/release`,
    {},
    signal
  )
}

export async function assignLogSheet(
  serverId: number | string,
  operatorId: number | string,
  signal?: AbortSignal
): Promise<ServerLogSheet> {
  return apiClient.post<ServerLogSheet>(
    `/api/log-sheets/${serverId}/assign`,
    { operatorId: Number(operatorId) },
    signal
  )
}

export async function reassignLogSheet(
  serverId: number | string,
  operatorId: number | string,
  signal?: AbortSignal
): Promise<ServerLogSheet> {
  return apiClient.post<ServerLogSheet>(
    `/api/log-sheets/${serverId}/reassign`,
    { operatorId: Number(operatorId) },
    signal
  )
}

export interface UnitOperatorOption {
  id: number
  fullName: string
}

export async function fetchUnitOperators(
  unitId: number | string,
  signal?: AbortSignal
): Promise<UnitOperatorOption[]> {
  return apiClient.get<UnitOperatorOption[]>(
    `/api/operational-units/${unitId}/operators`,
    signal
  )
}

// ===========================================================================
// Bootstrap — lightweight app context (no plant hierarchy / assets)
// ===========================================================================

export interface BootstrapResponse {
  serverTime: number
  userId: number
  operationalUnits: Array<Omit<OperationalUnit, 'id' | 'parentId'> & {
    id: string | number
    parentId?: string | number | null
  }>
  accessibleUnitIds: number[]
  supervisorScopeUnitIds: number[]
  primaryUnitId?: number | null
  /** Absent from a server older than this feature; the client keeps its defaults then. */
  attachmentLimits?: {
    maxImagesPerField: number
    maxAudiosPerField: number
    maxVideosPerField: number
    maxAudioSeconds: number
    maxVideoSeconds: number
  }
  /**
   * Rules the device follows but does not own. Optional for the same reason as the ceilings
   * above — an older server simply says nothing and the tablet keeps what it has, which is
   * the only safe answer for a policy that cannot be re-derived locally.
   */
  mobilePolicy?: {
    imageAnnotationEnabled: boolean
    nfcStrictSerialMatch: boolean
    /** Optional: a server older than this field says nothing, and the device stays strict. */
    nfcManualEntryEnabled?: boolean
  }
  /**
   * How long the tablet keeps its own copy of a round (backend roadmap §41). Absent from a server
   * older than that; the device then keeps whatever it had, or the constants it shipped with.
   * Every field is typed `unknown` because nothing here is trusted until
   * `normalizeDeviceRetention` has checked it.
   */
  deviceRetention?: {
    syncedRetentionHours?: unknown
    unsyncedPurgeEnabled?: unknown
    unsyncedRetentionHours?: unknown
  }
  /**
   * How long a signed-in session may keep working without any answer from the server (backend
   * V28). Absent from an older server; the device then never locks for lack of contact. Typed
   * `unknown` until `normalizeOfflineSessionLimit` has read it.
   */
  offlineSession?: {
    limitEnabled?: unknown
    limitHours?: unknown
  }
  /**
   * Lookup lists every FILL-able form needs (carrier 3). Absent on older servers.
   * Unioned with round `requiredLookups` before `syncRequiredLookups` so neither path drops
   * the other's lists.
   */
  requiredFormLookups?: RequiredLookup[]
}

export type MasterDataResponse = BootstrapResponse

export async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  return measuredRequest(() => apiClient.get<BootstrapResponse>('/api/bootstrap', signal))
}

/** Backward-compat alias — always returns slim bootstrap, never full master data. */
export async function fetchMasterData(
  _since?: number,
  signal?: AbortSignal
): Promise<BootstrapResponse> {
  return fetchBootstrap(signal)
}

// ===========================================================================
// Asset lookup  (NFC scan → asset)
// ===========================================================================

/**
 * GET /api/asset-entries/nfc/:tagId
 *
 * Given an NFC tag serial number, return the registered AssetEntry plus
 * its AssetClass (so the app can build the form immediately).
 * Returns null if the tag is not registered on the server.
 */
export interface AssetLookupResponse {
  entry: AssetEntry
  assetClass: AssetClass
}

export async function fetchAssetByNfcTag(
  nfcTagId: string,
  signal?: AbortSignal
): Promise<AssetLookupResponse | null> {
  try {
    return await apiClient.get<AssetLookupResponse>(
      `/api/asset-entries/nfc/${encodeURIComponent(nfcTagId)}`,
      signal
    )
  } catch (err) {
    // "Not registered" is a legitimate answer and returns null. Anything else —
    // offline, 401/403, a server fault — is a real failure the caller has to be
    // able to tell apart, so it propagates instead of masquerading as "no asset".
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

/**
 * POST /api/asset-entries/:id/nfc-serial
 *
 * Binds a scanned physical chip (the hardware UID) to an asset. Admin-only on the server —
 * the read permission above deliberately does not unlock this. An empty string clears the
 * binding. Errors propagate so the caller can show why (e.g. the chip is on another asset).
 */
export async function saveAssetNfcSerial(
  assetId: string | number,
  nfcSerial: string,
  signal?: AbortSignal
): Promise<AssetEntry> {
  return apiClient.post<AssetEntry>(
    `/api/asset-entries/${assetId}/nfc-serial`,
    { nfcSerial },
    signal
  )
}


// ===========================================================================
// Attachments (photo / voice note)
// ===========================================================================

export interface AttachmentDto {
  id: string
  logSheetId?: number | null
  formSubmissionId?: number | null
  assetId?: number | null
  fieldKey: string
  kind: 'IMAGE' | 'AUDIO' | 'VIDEO'
  mimeType: string
  sizeBytes: number
  sha256?: string
  width?: number
  height?: number
  durationMs?: number
  uploadedAt: number
  createdByUserId?: number
}

/**
 * Uploads one attachment.
 *
 * Deliberately its own request rather than part of `POST /api/log-sheets/batch`: a submission
 * has to stay small and atomic, so a dropped connection costs one photo instead of a whole
 * shift's readings. The `id` is minted on the device, which makes a retry idempotent — the
 * server returns the existing row rather than storing the file twice.
 *
 * Owner is XOR: `logSheetServerId` **or** `formSubmissionId` (carrier 3), never both.
 */
export async function uploadAttachment(params: {
  id: string
  logSheetServerId?: string | number
  formSubmissionId?: string | number
  /** Omitted for media answering the round's own question — see `LocalAttachment.assetId`. */
  assetId?: string | number
  fieldKey: string
  blob: Blob
  width?: number
  height?: number
  durationMs?: number
  signal?: AbortSignal
}): Promise<AttachmentDto> {
  const form = new FormData()
  form.append('id', params.id)
  if (params.formSubmissionId != null) {
    form.append('formSubmissionId', String(params.formSubmissionId))
  } else if (params.logSheetServerId != null) {
    form.append('logSheetId', String(params.logSheetServerId))
  } else {
    throw new Error('uploadAttachment requires logSheetServerId or formSubmissionId')
  }
  // Left out entirely rather than sent as "undefined": the server reads an absent assetId as
  // "this belongs to the round's own form", and a literal string would fail to parse as a Long.
  if (params.assetId != null) form.append('assetId', String(params.assetId))
  form.append('fieldKey', params.fieldKey)
  if (params.width != null) form.append('width', String(params.width))
  if (params.height != null) form.append('height', String(params.height))
  if (params.durationMs != null) form.append('durationMs', String(Math.round(params.durationMs)))
  form.append('file', params.blob, params.id)

  return apiClient.multipart<AttachmentDto>('/api/attachments', form, params.signal)
}

/** Fetches the bytes — only when the device no longer holds its own copy. */
export async function downloadAttachment(id: string, signal?: AbortSignal): Promise<Blob> {
  return apiClient.fetchBlob(`/api/attachments/${id}`, signal)
}

export async function deleteRemoteAttachment(
  id: string, signal?: AbortSignal, form?: { submissionId: string; fieldKey: string }
): Promise<void> {
  const path = form
    ? `/api/attachments/forms/${encodeURIComponent(form.submissionId)}/${encodeURIComponent(id)}?fieldKey=${encodeURIComponent(form.fieldKey)}`
    : `/api/attachments/${encodeURIComponent(id)}`
  await apiClient.delete<void>(path, signal)
}

// ===========================================================================
// Log sheets — submitted log sheet push
// ===========================================================================

export interface LogSheetSubmitResult {
  localId: string
  serverId?: number | string
  error?: string | null
  outcome?: 'SUBMITTED' | 'SUPERSEDED' | 'EXPIRED' | 'CANCELLED' | 'DUPLICATE' | 'ERROR'
  /**
   * Backend V25: `true` when the server refused to apply this round but kept it as a void
   * submission for review. `false` (backend V26, issue B-04 §2) when it would normally have kept
   * it and declined — this operator already has five different refusals on the round — which
   * matters because `SUPERSEDED`/`CANCELLED` otherwise imply kept. Absent from an older server,
   * and on every other outcome.
   */
  kept?: boolean | null
}

export interface ApiLogSheetEntry {
  assetId: number
  assetName: string
  subFunctionCode: string
  subFunctionTag: string
  nfcTagId?: string
  /** Echoed back unchanged; server-authoritative and ignored on submit. */
  nfcSerial?: string
  classId: number
  formData: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
  /** True when this entry was filled without an NFC scan (manual / fault-report fallback). */
  manualEntry?: boolean
  /**
   * Which channel captured this reading: `PWA_NFC`, `PWA_QR` or `PWA_MANUAL`.
   *
   * Sent beside `manualEntry` rather than instead of it. A server that predates this field reads
   * the boolean and behaves exactly as before; a current one prefers this, because a boolean
   * cannot tell a QR scan from a tag scan and the two carry different evidence.
   */
  entrySource?: string
}

/** Payload shape expected by POST /api/log-sheets/batch */
export interface LogSheetBatchItem {
  id?: number | string
  serverId?: number | string
  localId: string
  templateId?: number | string
  templateName?: string
  scopeSummary?: string
  operatorName?: string
  status?: string
  syncStatus?: string
  entries?: ApiLogSheetEntry[]
  submittedAt?: number
  createdAt?: number
  updatedAt?: number
  syncedAt?: number | null
  syncError?: string | null
  operationalUnitId?: number | string
  completedAt?: number
  clientActionId?: string
  /** Backend V28: the clock correction that went into `completedAt`. Evidence only. */
  clientClockOffsetMs?: number
  /**
   * Answers to the round's own questions.
   *
   * Omitted entirely when this round asks none, and the server reads an absent key as "this
   * client did not carry them" rather than "clear them" — which is what lets an older build
   * keep submitting without wiping what the web panel stored.
   */
  sheetFormData?: Record<string, unknown>
}

/**
 * POST /api/log-sheets/batch
 *
 * Send one or more submitted LogSheets to the server.
 */
export async function submitLogSheetsBatch(
  logSheets: LogSheetBatchItem[],
  signal?: AbortSignal
): Promise<LogSheetSubmitResult[]> {
  return apiClient.post<LogSheetSubmitResult[]>(
    '/api/log-sheets/batch',
    { logSheets },
    signal
  )
}

// ===========================================================================
// Progress — partial values from a round still being walked
// ===========================================================================

/**
 * What the server did with one sheet's partial values.
 *
 * **Its own vocabulary, deliberately not `LogSheetSubmitResult`'s.** A submit result says whether
 * a round was delivered; this says whether a report about an *unfinished* round was accepted, and
 * the device has to act on the two differently. A refused progress push changes nothing about the
 * operator's work and must never touch the row's `status` or `syncStatus` — those belong to the
 * submit path. Sharing one type is how a "the server said no" branch ends up marking real,
 * undelivered work as failed.
 *
 * There is no `DUPLICATE`. Progress carries no `clientActionId` and is meant to be re-sent.
 */
export interface LogSheetProgressResult {
  localId: string
  serverId?: number | string
  error?: string | null
  outcome?:
    | 'SAVED'
    | 'NO_CHANGE'
    | 'SUPERSEDED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'VALIDATION_ERROR'
    | 'ERROR'
  /** Server time the progress was stamped, on an accepted push only — or, with `kept`, kept. */
  savedAt?: number | null
  /**
   * Backend V25: on an `EXPIRED` answer, `true` when the readings were kept for the supervisor
   * (not applied to the round). Absent from an older server.
   */
  kept?: boolean | null
}

/**
 * Payload shape expected by POST /api/log-sheets/progress.
 *
 * **`entries` carries only what changed since the last accepted push**, not the whole sheet —
 * the opposite of a submit, which resends every asset so the delivered round is self-contained.
 * A progress push runs on a timer, so making it proportional to the work actually done rather
 * than to the size of the sheet is what keeps the cost proportional to the plant instead of to
 * the clock.
 */
export interface LogSheetProgressItem {
  serverId: number | string
  localId: string
  operatorName?: string
  entries: ApiLogSheetEntry[]
  /**
   * The round's own answers as they stand on the device — whole, not a delta.
   *
   * One small map per sheet rather than one per asset, so sending it entire costs nothing and
   * removes the question of how a cleared answer would be expressed in a delta. The server
   * keeps what a correction replaces here exactly as it does for the web panel, but does not
   * apply the required check: a round being walked is partial by definition.
   */
  sheetFormData?: Record<string, unknown>
}

/**
 * POST /api/log-sheets/progress
 *
 * Report how far one or more rounds have got, without completing any of them.
 */
/**
 * Backend V25: how many rounds this tablet holds whose readings the server has received in no
 * form, and the oldest. Shown on the panel's «نشست‌های اپ موبایل»; changes nothing else.
 */
export interface SyncBacklogReport {
  undeliveredCount: number
  oldestUndeliveredAt: number | null
}

export async function reportSyncBacklog(
  report: SyncBacklogReport,
  signal?: AbortSignal
): Promise<void> {
  await apiClient.post<unknown>('/api/sync/backlog', report, signal)
}

export async function pushLogSheetProgressBatch(
  logSheets: LogSheetProgressItem[],
  signal?: AbortSignal
): Promise<LogSheetProgressResult[]> {
  return apiClient.post<LogSheetProgressResult[]>(
    '/api/log-sheets/progress',
    { logSheets },
    signal
  )
}

// ===========================================================================
// NFC fault reports — "NFC scan failed" reports push
// ===========================================================================

export interface NfcFaultReportSubmitResult {
  localId: string
  serverId?: number | string
  error?: string | null
  outcome?: 'CREATED' | 'DUPLICATE' | 'ERROR'
}

/** Payload shape expected by POST /api/nfc-fault-reports/batch */
export interface NfcFaultReportBatchItem {
  logSheetId: number
  assetId: number
  reason?: string
  createdAt?: number
  clientActionId?: string
  localId: string
}

/**
 * POST /api/nfc-fault-reports/batch
 *
 * Send one or more locally-filed NFC fault reports to the server.
 */
export async function submitNfcFaultReportsBatch(
  reports: NfcFaultReportBatchItem[],
  signal?: AbortSignal
): Promise<NfcFaultReportSubmitResult[]> {
  return apiClient.post<NfcFaultReportSubmitResult[]>(
    '/api/nfc-fault-reports/batch',
    { reports },
    signal
  )
}

// ===========================================================================
// Ad-hoc field forms (carrier 3) — never touches log_sheets
// ===========================================================================

export interface FormDefinitionDto {
  schemaVersionId?: number | string
  id: number | string
  code: string
  title: string
  description?: string | null
  active: boolean
  subjectUnitIds: Array<number | string>
  fields: Array<{
    id?: number | string
    classId?: number | string | null
    key: string
    label: string
    dataType: string
    unit?: string | null
    required?: boolean
    validation?: FieldDefinition['validation']
    order?: number | null
    version?: number | null
  }>
  requiredLookups?: RequiredLookup[]
}

export interface FormSubmissionDto {
  id: number | string
  formDefinitionId: number | string
  status: string
  reporterUnitId: number | string
  subjectUnitId: number | string
  formData?: Record<string, unknown>
  fieldDefinitionsSnapshot?: FormDefinitionDto['fields']
  reportedByUserId?: number | string
  reportedByName?: string
  lastSavedByName?: string | null
  source?: string
  localId?: string
  createdAt?: number
  updatedAt?: number
  submittedAt?: number
  syncedAt?: number
  deviceTimeAt?: number
}

export interface FormDraftRequest {
  legacyFields?: FormDefinitionDto['fields']
  schemaVersionId?: number | string
  submissionId?: number | string | null
  formDefinitionId: number | string
  reporterUnitId: number | string
  subjectUnitId: number | string
  localId: string
  clientActionId?: string
  formData?: Record<string, unknown>
  deviceTimeAt?: number
}

export interface FormSubmitRequest {
  legacyFields?: FormDefinitionDto['fields']
  requireUploadedMedia?: boolean
  schemaVersionId?: number | string
  submissionId?: number | string | null
  formDefinitionId: number | string
  reporterUnitId: number | string
  subjectUnitId: number | string
  localId: string
  clientActionId: string
  formData?: Record<string, unknown>
  deviceTimeAt?: number
}

export type FormSubmitOutcome =
  | 'OK'
  | 'DUPLICATE'
  | 'VALIDATION_ERROR'
  | 'DENIED'
  | 'IMMUTABLE'
  | string

export interface FormSubmitResult {
  submissionId?: number | string | null
  localId?: string | null
  outcome: FormSubmitOutcome
  status?: string | null
  message?: string | null
}

/** GET /api/forms — fillable forms for the signed-in user. */
export async function fetchFillableForms(signal?: AbortSignal): Promise<FormDefinitionDto[]> {
  return apiClient.get<FormDefinitionDto[]>('/api/forms', signal)
}

/** GET /api/forms/{id} */
export async function fetchFillableForm(
  id: string | number,
  signal?: AbortSignal
): Promise<FormDefinitionDto> {
  return apiClient.get<FormDefinitionDto>(`/api/forms/${id}`, signal)
}

/** POST /api/forms/drafts — partial upsert; required fields do not block. */
export async function upsertFormDraft(
  body: FormDraftRequest,
  signal?: AbortSignal
): Promise<FormSubmitResult> {
  return apiClient.post<FormSubmitResult>('/api/forms/drafts', body, signal)
}

/** POST /api/forms/submit — immutable final; clientActionId required. */
export async function submitFormFinal(
  body: FormSubmitRequest,
  signal?: AbortSignal
): Promise<FormSubmitResult> {
  return apiClient.post<FormSubmitResult>('/api/forms/submit', body, signal)
}

/** GET /api/form-submissions — caller's own drafts + submitted. */
export async function fetchMyFormSubmissions(signal?: AbortSignal): Promise<FormSubmissionDto[]> {
  return apiClient.get<FormSubmissionDto[]>('/api/form-submissions', signal)
}

/** GET /api/form-submissions/{id} */
export async function fetchFormSubmission(
  id: string | number,
  signal?: AbortSignal
): Promise<FormSubmissionDto> {
  return apiClient.get<FormSubmissionDto>(`/api/form-submissions/${id}`, signal)
}
