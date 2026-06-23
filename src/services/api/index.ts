/**
 * All server API calls go through this file.
 * UI components and sync services import from here — never from apiClient directly.
 * This makes backend changes easy to isolate.
 */

import { apiClient } from './client'
import type { AssetInfo, DataRecord, FormSchema } from '@/types'

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Fetch asset info from server based on NFC tag ID */
export async function fetchAssetByNfcTag(
  nfcTagId: string,
  signal?: AbortSignal
): Promise<AssetInfo | null> {
  try {
    return await apiClient.get<AssetInfo>(`/api/assets/nfc/${encodeURIComponent(nfcTagId)}`, signal)
  } catch {
    return null
  }
}

/** Fetch all known assets (for offline caching) */
export async function fetchAllAssets(signal?: AbortSignal): Promise<AssetInfo[]> {
  return apiClient.get<AssetInfo[]>('/api/assets', signal)
}

// ---------------------------------------------------------------------------
// Form schemas
// ---------------------------------------------------------------------------

/** Fetch form schema from the server for a given form type */
export async function fetchFormSchema(
  formType: string,
  signal?: AbortSignal
): Promise<FormSchema | null> {
  try {
    return await apiClient.get<FormSchema>(`/api/forms/${encodeURIComponent(formType)}`, signal)
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
