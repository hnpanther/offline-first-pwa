/**
 * Master data pull service.
 *
 * Pulls all configuration from the server and merges it into IndexedDB.
 * This is the "read config from server" flow — separate from the
 * "push collected data to server" flow in SyncManager.
 *
 * When to call:
 *  - On app first launch (lastPullAt is null)
 *  - When user taps "Sync" in settings
 *  - Periodically (e.g. once per hour) while online
 *
 * The merge strategy is last-write-wins on the server's version:
 *  - Existing local records with the same id are overwritten.
 *  - Records absent from the server response are kept locally (partial pull
 *    via `since` timestamp).
 *  - On full pull (no `since`), the server is the source of truth.
 */

import { db } from '@/services/storage/db'
import { fetchMasterData } from '@/services/api'
import type { MasterDataResponse } from '@/services/api'

export type PullStatus = 'idle' | 'pulling' | 'success' | 'error'

export interface PullResult {
  success: boolean
  counts?: Partial<Record<keyof Omit<MasterDataResponse, 'serverTime'>, number>>
  error?: string
  serverTime?: number
}

// ---------------------------------------------------------------------------
// Last-pull timestamp — stored in syncMeta.key='lastPullAt'
// ---------------------------------------------------------------------------

async function getLastPullAt(): Promise<number | null> {
  const row = await db.syncMeta.get('lastPullAt')
  return typeof row?.value === 'number' ? row.value : null
}

async function setLastPullAt(ts: number): Promise<void> {
  await db.syncMeta.put({ key: 'lastPullAt', value: ts })
}

// ---------------------------------------------------------------------------
// Merge helpers — bulk-put each collection
// ---------------------------------------------------------------------------

async function mergeCollection<T extends { id: string }>(
  table: { bulkPut: (items: T[]) => Promise<unknown> },
  items: T[]
): Promise<void> {
  if (items.length > 0) await table.bulkPut(items)
}

// ---------------------------------------------------------------------------
// Main pull function
// ---------------------------------------------------------------------------

/**
 * Pull master data from the server and upsert into IndexedDB.
 *
 * @param incremental  If true, only fetches records updated since last pull.
 *                     If false (default on first run), fetches everything.
 * @param signal       AbortSignal to cancel the request.
 */
export async function pullMasterData(
  incremental = true,
  signal?: AbortSignal
): Promise<PullResult> {
  try {
    const since = incremental ? await getLastPullAt() : null
    const data = await fetchMasterData(since ?? undefined, signal)

    // Merge each collection into IndexedDB in a single transaction-like sequence.
    // Using bulkPut means "insert or overwrite by primary key".
    await Promise.all([
      mergeCollection(db.locations, data.locations),
      mergeCollection(db.plantSystems, data.plantSystems),
      mergeCollection(db.mainFunctions, data.mainFunctions),
      mergeCollection(db.subFunctions, data.subFunctions),
      mergeCollection(db.assetClasses, data.assetClasses),
      mergeCollection(db.fieldDefinitions, data.fieldDefinitions),
      mergeCollection(db.assetEntries, data.assetEntries),
      mergeCollection(db.logSheetTemplates, data.logSheetTemplates),
    ])

    await setLastPullAt(data.serverTime)

    return {
      success: true,
      serverTime: data.serverTime,
      counts: {
        locations: data.locations.length,
        plantSystems: data.plantSystems.length,
        mainFunctions: data.mainFunctions.length,
        subFunctions: data.subFunctions.length,
        assetClasses: data.assetClasses.length,
        fieldDefinitions: data.fieldDefinitions.length,
        assetEntries: data.assetEntries.length,
        logSheetTemplates: data.logSheetTemplates.length,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطا در دریافت اطلاعات از سرور',
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: pull only if data is stale (older than maxAgeMs)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour

export async function pullMasterDataIfStale(
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  signal?: AbortSignal
): Promise<PullResult> {
  const lastPullAt = await getLastPullAt()
  const isStale = lastPullAt == null || Date.now() - lastPullAt > maxAgeMs

  if (!isStale) {
    return { success: true }
  }

  // First pull ever → full pull. Subsequent → incremental.
  return pullMasterData(lastPullAt != null, signal)
}
