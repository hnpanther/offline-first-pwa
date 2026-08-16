/**
 * Lightweight bootstrap pull — operational units and user context only.
 * Plant hierarchy and assets arrive per log-sheet bundle, never as a full dump.
 */

import { db } from '@/services/storage/db'
import { getSettings, saveSettings } from '@/services/storage'
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

    // Ceilings and policies are server-owned. Refreshing them here is what makes a change in
    // the web panel (or in the deployment's own configuration) take effect on every tablet
    // without anyone touching the device. A server that does not send a block leaves whatever
    // the device already had — never a reset to defaults, which would silently widen a limit
    // or weaken the scan rule someone tightened.
    //
    // Both blocks land in one write. Two read-modify-write passes would race and the second
    // would overwrite the first with its own stale snapshot.
    if (data.attachmentLimits || data.mobilePolicy) {
      const settings = await getSettings()
      await saveSettings({
        ...settings,
        ...(data.attachmentLimits ? { attachmentLimits: data.attachmentLimits } : {}),
        ...(data.mobilePolicy
          ? {
              imageAnnotationEnabled: data.mobilePolicy.imageAnnotationEnabled,
              nfcStrictSerialMatch: data.mobilePolicy.nfcStrictSerialMatch
            }
          : {})
      })
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

/**
 * @param maxAgeMs how old the last pull may be before this one actually fetches. **Zero means
 *        force** — callers rely on that to apply a change right now (a fresh sign-in does).
 *        The comparison is `>=` for exactly that reason: with `>`, a maxAge of 0 would decline
 *        to fetch whenever no measurable time had passed since the previous pull, so the
 *        "force" would silently do nothing on a fast path.
 */
export async function pullBootstrapIfStale(
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  signal?: AbortSignal
): Promise<PullResult> {
  const lastBootstrapAt = await getLastBootstrapAt()
  const isStale = lastBootstrapAt == null || Date.now() - lastBootstrapAt >= maxAgeMs

  if (!isStale) {
    return { success: true }
  }

  return pullBootstrap(signal)
}
