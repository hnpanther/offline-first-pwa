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
 *   - Records  (push DataRecords)
 *   - Log sheets (push submitted log sheets)
 *   - Sync engine (outbox push / incremental pull)
 */

import { apiClient } from './client'
import type {
  AssetClass,
  AssetEntry,
  Location,
  PlantSystem,
  MainFunction,
  SubFunction,
  LogSheetServerStatus,
  LogSheetAssignmentType,
  DataRecord,
  OperationalUnit
} from '@/types'
import type { FieldDefinition, OutboxEntry } from '@/types/sync'
import type { LoginRequest, LoginResponse } from '@/types/auth'

// ===========================================================================
// Health
// ===========================================================================

export interface HealthResponse {
  status: 'ok'
  version?: string
  serverTime?: number
}

/** Lightweight ping — used by SyncManager and the Settings page. */
export async function checkServerHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    await apiClient.get<HealthResponse>('/api/health', signal, false)
    return true
  } catch {
    return false
  }
}

// ===========================================================================
// Auth
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
  classId?: number | null
  formData?: Record<string, unknown> | null
  createdAt?: number | null
  updatedAt?: number | null
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

export async function fetchLogSheetEntries(
  serverId: number | string,
  signal?: AbortSignal
): Promise<ServerLogSheetEntry[]> {
  return apiClient.get<ServerLogSheetEntry[]>(
    `/api/log-sheets/${serverId}/entries`,
    signal
  )
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
}

/** @deprecated Use BootstrapResponse */
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
  } catch {
    return null
  }
}

// ===========================================================================
// Records — DataRecord push
// ===========================================================================

export interface RecordSubmitResult {
  localId: string
  serverId?: string
  error?: string
}

/**
 * POST /api/records/batch
 *
 * Send one or more approved DataRecords to the server.
 * Only records with recordStatus==='approved' are ever submitted.
 * The server responds per-record with its assigned serverId or an error.
 */
export async function submitRecordsBatch(
  records: DataRecord[],
  signal?: AbortSignal
): Promise<RecordSubmitResult[]> {
  return apiClient.post<RecordSubmitResult[]>(
    '/api/records/batch',
    { records },
    signal
  )
}

// ===========================================================================
// Log sheets — submitted log sheet push
// ===========================================================================

export interface LogSheetSubmitResult {
  localId: string
  serverId?: number | string
  error?: string | null
  outcome?: 'SUBMITTED' | 'SUPERSEDED' | 'EXPIRED' | 'DUPLICATE' | 'ERROR'
}

export interface ApiLogSheetEntry {
  assetId: number
  assetName: string
  subFunctionCode: string
  subFunctionTag: string
  nfcTagId?: string
  classId: number
  formData: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
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
// Sync engine — outbox push / incremental pull
// (infrastructure for the future push.ts / pull.ts engines)
// ===========================================================================

/**
 * POST /api/sync/push
 *
 * Batch-push outbox entries (created by Repository) to the server.
 * entityType values: 'asset_class' | 'field_definition' | 'asset_entry' |
 *   'location' | 'plant_system' | 'main_function' | 'sub_function' |
 *   'log_sheet_template'
 *
 * // SYNC ENGINE HOOK — called from src/services/sync/push.ts (future)
 */
export interface OutboxPushResult {
  id: string          // OutboxEntry.id
  accepted: boolean
  error?: string
}

export async function pushOutboxBatch(
  entries: OutboxEntry[],
  signal?: AbortSignal
): Promise<OutboxPushResult[]> {
  return apiClient.post<OutboxPushResult[]>(
    '/api/sync/push',
    { entries },
    signal
  )
}

/**
 * GET /api/sync/changes?since=<seq>
 *
 * Incremental pull: server returns all entity changes since the last
 * sequence number the device acknowledged.
 * `seq` is stored in syncMeta { key: 'lastSeq', value: <seq> }.
 *
 * // SYNC ENGINE HOOK — called from src/services/sync/pull.ts (future)
 */
export interface SyncChange {
  seq: number
  entityType: string
  entityId: string
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
}

export interface SyncChangesResponse {
  changes: SyncChange[]
  latestSeq: number
}

export async function fetchSyncChanges(
  since: number,
  signal?: AbortSignal
): Promise<SyncChangesResponse> {
  return apiClient.get<SyncChangesResponse>(`/api/sync/changes?since=${since}`, signal)
}
