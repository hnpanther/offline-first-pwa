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
  Location,
  PlantSystem,
  MainFunction,
  SubFunction,
  LogSheetServerStatus,
  LogSheetAssignmentType,
  OperationalUnit
} from '@/types'
import type { FieldDefinition } from '@/types/sync'
import type { LoginRequest, LoginResponse } from '@/types/auth'

// ===========================================================================
// Health
// ===========================================================================

export async function login(
  credentials: LoginRequest,
  signal?: AbortSignal
): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/api/auth/login', credentials, signal, false)
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
}

/** Self-contained server payload for one log sheet (metadata + entries + scoped context). */
export interface LogSheetBundleDto {
  sheet: ServerLogSheet
  entries: ServerLogSheetEntry[]
  context: LogSheetContextDto | null
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
  return apiClient.get<LogSheetInboxResponse>('/api/log-sheets/inbox', signal)
}

export async function fetchLogSheetBundle(
  serverId: number | string,
  signal?: AbortSignal
): Promise<LogSheetBundleDto> {
  return apiClient.get<LogSheetBundleDto>(`/api/log-sheets/${serverId}/bundle`, signal)
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
}

export type MasterDataResponse = BootstrapResponse

export async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  return apiClient.get<BootstrapResponse>('/api/bootstrap', signal)
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
  logSheetId: number
  assetId: number
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
 */
export async function uploadAttachment(params: {
  id: string
  logSheetServerId: string | number
  assetId: string | number
  fieldKey: string
  blob: Blob
  width?: number
  height?: number
  durationMs?: number
  signal?: AbortSignal
}): Promise<AttachmentDto> {
  const form = new FormData()
  form.append('id', params.id)
  form.append('logSheetId', String(params.logSheetServerId))
  form.append('assetId', String(params.assetId))
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

export async function deleteRemoteAttachment(id: string, signal?: AbortSignal): Promise<void> {
  await apiClient.delete<void>(`/api/attachments/${id}`, signal)
}

// ===========================================================================
// Log sheets — submitted log sheet push
// ===========================================================================

export interface LogSheetSubmitResult {
  localId: string
  serverId?: number | string
  error?: string | null
  outcome?: 'SUBMITTED' | 'SUPERSEDED' | 'EXPIRED' | 'CANCELLED' | 'DUPLICATE' | 'ERROR'
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
  /** Server time the progress was stamped, on an accepted push only. */
  savedAt?: number | null
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
}

/**
 * POST /api/log-sheets/progress
 *
 * Report how far one or more rounds have got, without completing any of them.
 */
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
