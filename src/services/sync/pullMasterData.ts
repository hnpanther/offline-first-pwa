/**
 * Bootstrap pull service.
 *
 * Pulls lightweight user/unit context from the server. Plant hierarchy,
 * assets, and form fields are delivered per log-sheet bundle instead.
 */

import { db } from '@/services/storage/db'
import { fetchBootstrap } from '@/services/api'
import type { BootstrapResponse } from '@/services/api'
import { toIdString } from '@/utils/ids'

export type PullStatus = 'idle' | 'pulling' | 'success' | 'error'

export interface PullResult {
  success: boolean
  counts?: {
    operationalUnits?: number
  }
  error?: string
  serverTime?: number
}

async function getLastPullAt(): Promise<number | null> {
  const row = await db.syncMeta.get('lastPullAt')
  return typeof row?.value === 'number' ? row.value : null
}

async function setLastPullAt(ts: number): Promise<void> {
  await db.syncMeta.put({ key: 'lastPullAt', value: ts })
}

async function saveBootstrapMeta(data: BootstrapResponse): Promise<void> {
  await db.syncMeta.put({
    key: 'bootstrap',
    value: {
      userId: data.userId != null ? toIdString(data.userId) : undefined,
      primaryUnitId:
        data.primaryUnitId != null ? toIdString(data.primaryUnitId) : undefined,
      accessibleUnitIds: (data.accessibleUnitIds ?? []).map(toIdString),
      supervisorScopeUnitIds: (data.supervisorScopeUnitIds ?? []).map(toIdString),
      operationalUnits: data.operationalUnits ?? [],
      serverTime: data.serverTime
    }
  })
}

/**
 * Pull bootstrap from the server and cache user/unit context in syncMeta.
 */
export async function pullMasterData(
  _incremental = true,
  signal?: AbortSignal
): Promise<PullResult> {
  try {
    const data = await fetchBootstrap(signal)
    await setLastPullAt(data.serverTime)
    await saveBootstrapMeta(data)

    return {
      success: true,
      serverTime: data.serverTime,
      counts: {
        operationalUnits: data.operationalUnits?.length ?? 0
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطا در دریافت اطلاعات از سرور'
    }
  }
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000

export async function pullMasterDataIfStale(
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  signal?: AbortSignal
): Promise<PullResult> {
  const lastPullAt = await getLastPullAt()
  const isStale = lastPullAt == null || Date.now() - lastPullAt > maxAgeMs

  if (!isStale) {
    return { success: true }
  }

  return pullMasterData(false, signal)
}
