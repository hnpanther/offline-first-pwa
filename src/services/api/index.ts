/**
 * ALL server API calls are defined here.
 * UI components, hooks, and sync services import only from this file.
 * Never import apiClient directly outside this module.
 *
 * Endpoint groups:
 *   - Health
 *   - Master data (pull config from server)
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
  LogSheetTemplate,
  LogSheet,
  DataRecord
} from '@/types'
import type { FieldDefinition, OutboxEntry } from '@/types/sync'

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
    await apiClient.get<HealthResponse>('/api/health', signal)
    return true
  } catch {
    return false
  }
}

// ===========================================================================
// Master data — configuration pulled FROM the server
// ===========================================================================

/**
 * Full snapshot of all configuration the device needs.
 * The server returns everything in one call to minimise round-trips.
 * Pass `since` (Unix ms) to get only records updated after that timestamp
 * (incremental pull).  If `since` is omitted the server sends the full set.
 */
export interface MasterDataResponse {
  locations: Location[]
  plantSystems: PlantSystem[]
  mainFunctions: MainFunction[]
  subFunctions: SubFunction[]
  assetClasses: AssetClass[]
  /** Each AssetClass has its FieldDefinitions inlined here */
  fieldDefinitions: FieldDefinition[]
  assetEntries: AssetEntry[]
  logSheetTemplates: LogSheetTemplate[]
  /** Server-side timestamp of this snapshot — save as lastPullAt in syncMeta */
  serverTime: number
}

/**
 * GET /api/master-data[?since=<ms>]
 *
 * Pull master data (config) from the server.
 * On first run call with no `since`.
 * On subsequent runs pass the `serverTime` from the previous response.
 */
export async function fetchMasterData(
  since?: number,
  signal?: AbortSignal
): Promise<MasterDataResponse> {
  const qs = since != null ? `?since=${since}` : ''
  return apiClient.get<MasterDataResponse>(`/api/master-data${qs}`, signal)
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
  serverId?: string
  error?: string
}

/**
 * POST /api/log-sheets/batch
 *
 * Send one or more submitted LogSheets to the server.
 * Only log sheets with status==='submitted' are ever sent.
 */
export async function submitLogSheetsBatch(
  logSheets: LogSheet[],
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
