/**
 * All server API calls go through this file.
 * UI components and sync services import from here — never from apiClient directly.
 * This makes backend changes easy to isolate.
 */

import { apiClient } from './client'
import type { AssetEntry, AssetClass, DataRecord } from '@/types'

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Fetch asset info from server based on NFC tag ID */
export async function fetchAssetByNfcTag(
  nfcTagId: string,
  signal?: AbortSignal
): Promise<AssetEntry | null> {
  try {
    return await apiClient.get<AssetEntry>(`/api/assets/nfc/${encodeURIComponent(nfcTagId)}`, signal)
  } catch {
    return null
  }
}

/** Fetch all known assets (for offline caching) */
export async function fetchAllAssets(signal?: AbortSignal): Promise<AssetEntry[]> {
  return apiClient.get<AssetEntry[]>('/api/assets', signal)
}

// ---------------------------------------------------------------------------
// Asset classes (form schemas)
// ---------------------------------------------------------------------------

/** Fetch asset class schema from the server */
export async function fetchFormSchema(
  formType: string,
  signal?: AbortSignal
): Promise<AssetClass | null> {
  try {
    return await apiClient.get<AssetClass>(`/api/forms/${encodeURIComponent(formType)}`, signal)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Records sync
// ---------------------------------------------------------------------------

export interface SyncRecordResponse {
  serverId: string
  status: 'created' | 'updated'
}

/** Submit a single collected data record to the server */
export async function submitRecord(
  record: DataRecord,
  signal?: AbortSignal
): Promise<SyncRecordResponse> {
  return apiClient.post<SyncRecordResponse>('/api/records', record, signal)
}

/** Submit multiple records in one batch request */
export async function submitRecordsBatch(
  records: DataRecord[],
  signal?: AbortSignal
): Promise<Array<{ localId: string; serverId?: string; error?: string }>> {
  return apiClient.post<Array<{ localId: string; serverId?: string; error?: string }>>(
    '/api/records/batch',
    { records },
    signal
  )
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/** Lightweight ping to check server availability */
export async function checkServerHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    await apiClient.get('/api/health', signal)
    return true
  } catch {
    return false
  }
}
