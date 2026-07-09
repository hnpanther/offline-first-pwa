/**
 * Lightweight bootstrap pull — operational units and user context only.
 * Plant hierarchy and assets arrive per log-sheet bundle, never as a full dump.
 */

import { db } from '@/services/storage/db'
import { fetchBootstrap } from '@/services/api'
import type { BootstrapResponse } from '@/services/api'
import { toIdString } from '@/utils/ids'
import type { OperationalUnit } from '@/types'

export type PullStatus = 'idle' | 'pulling' | 'success' | 'error'

export interface PullResult {
  success: boolean
  error?: string
  serverTime?: number
  operationalUnitCount?: number
}

async function getLastBootstrapAt(): Promise<number | null> {
  const row = await db.syncMeta.get('lastBootstrapAt')
  return typeof row?.value === 'number' ? row.value : null
}

async function setLastBootstrapAt(ts: number): Promise<void> {
  await db.syncMeta.put({ key: 'lastBootstrapAt', value: ts })
}

function normalizeOperationalUnits(
  units: BootstrapResponse['operationalUnits']
): OperationalUnit[] {
  return units.map(u => ({
    id: toIdString(u.id),
    code: u.code,
    name: u.name,
    parentId: u.parentId != null ? toIdString(u.parentId) : undefined,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  }))
}

export async function pullBootstrap(signal?: AbortSignal): Promise<PullResult> {
  try {
    const data = await fetchBootstrap(signal)
    const units = normalizeOperationalUnits(data.operationalUnits ?? [])

    if (units.length > 0) {
      await db.operationalUnits.bulkPut(units)
    }

    await setLastBootstrapAt(data.serverTime)

    return {
      success: true,
      serverTime: data.serverTime,
      operationalUnitCount: units.length
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطا در دریافت اطلاعات از سرور'
    }
  }
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000

export async function pullBootstrapIfStale(
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  signal?: AbortSignal
): Promise<PullResult> {
  const lastBootstrapAt = await getLastBootstrapAt()
  const isStale = lastBootstrapAt == null || Date.now() - lastBootstrapAt > maxAgeMs

  if (!isStale) {
    return { success: true }
  }

  return pullBootstrap(signal)
}
