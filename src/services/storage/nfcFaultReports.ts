import { v4 as uuidv4 } from 'uuid'
import { db } from '@/services/storage/db'
import type { NfcFaultReport, SyncStatus } from '@/types'

/** Creates a fault report and immediately unlocks manual entry for this device. */
export async function createNfcFaultReport(data: {
  logSheetServerId: string
  assetId: string
  reason?: string
  reportedByName?: string
}): Promise<NfcFaultReport> {
  const report: NfcFaultReport = {
    id: uuidv4(),
    logSheetServerId: data.logSheetServerId,
    assetId: data.assetId,
    reason: data.reason,
    reportedByName: data.reportedByName,
    source: 'MOBILE',
    createdAt: Date.now(),
    syncStatus: 'pending',
    clientActionId: uuidv4()
  }
  await db.nfcFaultReports.add(report)
  return report
}

export async function getNfcFaultReportsForSheet(
  logSheetServerId: string
): Promise<NfcFaultReport[]> {
  return db.nfcFaultReports.where('logSheetServerId').equals(logSheetServerId).toArray()
}

/** Whether manual entry should be unlocked for this asset within this log sheet. */
export async function hasNfcFaultReport(
  logSheetServerId: string,
  assetId: string
): Promise<boolean> {
  const reports = await getNfcFaultReportsForSheet(logSheetServerId)
  return reports.some(r => r.assetId === assetId)
}

export async function getPendingNfcFaultReports(): Promise<NfcFaultReport[]> {
  return db.nfcFaultReports.where('syncStatus').anyOf(['pending', 'failed']).toArray()
}

export async function updateNfcFaultReportSyncStatus(
  id: string,
  status: SyncStatus,
  extra?: { serverId?: string; syncError?: string; syncedAt?: number }
): Promise<void> {
  await db.nfcFaultReports.update(id, { syncStatus: status, ...(extra ?? {}) })
}
