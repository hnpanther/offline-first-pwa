import { v4 as uuidv4 } from 'uuid'
import { db } from '@/services/storage/db'
import { getSessionUserId } from '@/services/auth/sessionContext'
import type { NfcFaultReport, SyncStatus } from '@/types'

/** Creates a fault report and immediately unlocks manual entry for this device. */
export async function createNfcFaultReport(data: {
  logSheetServerId: string
  assetId: string
  reason?: string
  reportedByName?: string
}): Promise<NfcFaultReport> {
  const createdByUserId = await getSessionUserId()
  const report: NfcFaultReport = {
    id: uuidv4(),
    logSheetServerId: data.logSheetServerId,
    assetId: data.assetId,
    reason: data.reason,
    reportedByName: data.reportedByName,
    source: 'MOBILE',
    createdAt: Date.now(),
    syncStatus: 'pending',
    clientActionId: uuidv4(),
    ...(createdByUserId ? { createdByUserId } : {})
  }
  await db.nfcFaultReports.add(report)
  return report
}

export async function getNfcFaultReportsForSheet(
  logSheetServerId: string
): Promise<NfcFaultReport[]> {
  return db.nfcFaultReports.where('logSheetServerId').equals(logSheetServerId).toArray()
}

/**
 * Whether a locally-stored report may be pushed under the given logged-in user's
 * session. A shared device may hold a still-pending report filed by a previous
 * user who logged out before it synced — it must wait for that user to return
 * rather than being uploaded and attributed to whoever is logged in now.
 */
export function isNfcFaultReportOutboundOwnedByUser(
  report: Pick<NfcFaultReport, 'createdByUserId'>,
  userId: string | null
): boolean {
  if (!userId) return false
  if (!report.createdByUserId) return true // legacy record predating per-user stamping
  return report.createdByUserId === userId
}

export async function getPendingNfcFaultReports(userId: string | null): Promise<NfcFaultReport[]> {
  const all = await db.nfcFaultReports.where('syncStatus').anyOf(['pending', 'failed']).toArray()
  return all.filter(r => isNfcFaultReportOutboundOwnedByUser(r, userId))
}

export async function updateNfcFaultReportSyncStatus(
  id: string,
  status: SyncStatus,
  extra?: { serverId?: string; syncError?: string; syncedAt?: number }
): Promise<void> {
  await db.nfcFaultReports.update(id, { syncStatus: status, ...(extra ?? {}) })
}
