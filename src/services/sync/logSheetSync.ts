import { v4 as uuidv4 } from 'uuid'
import {
  getLogSheetTemplate,
  getAssetsInScope,
  getAllSubFunctions,
  getSettings,
  saveLogSheet,
  updateLogSheet,
  getLogSheetByServerId,
  getAllLogSheets
} from '@/services/storage'
import type { ServerLogSheet } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'
import { toIdString } from '@/utils/ids'
import { isLogSheetExpiredForSync, isLogSheetExpired, SYNC_OUTCOME_MESSAGES, isInvalidLocalLogSheet, isRevokedSyncError } from '@/utils/logSheetStatus'

export async function buildEntriesForTemplate(
  templateId: string
): Promise<LogSheetEntryData[]> {
  const template = await getLogSheetTemplate(templateId)
  if (!template) return []

  const assets = await getAssetsInScope(
    template.scopeType,
    template.scopeId,
    template.classId
  )
  if (assets.length === 0) return []

  const allSubFunctions = await getAllSubFunctions()
  const sfMap = new Map(allSubFunctions.map(sf => [sf.id, sf]))

  return assets.map(asset => {
    const sf = sfMap.get(asset.subFunctionId)
    return {
      assetId: asset.id,
      assetName: asset.assetName,
      subFunctionCode: sf?.code ?? '',
      subFunctionTag: sf?.tag ?? '',
      nfcTagId: asset.nfcTagId,
      classId: toIdString(asset.classId),
      formData: {}
    }
  })
}

/** User was reassigned away earlier; server put the sheet back in their inbox. */
function revivalUpdatesAfterReassign(local: LogSheet): Partial<LogSheet> | null {
  if (!isRevokedSyncError(local.syncError)) return null
  const updates: Partial<LogSheet> = { syncError: undefined }
  if (local.syncStatus === 'failed') {
    updates.syncStatus = 'pending'
  }
  return updates
}

export async function ensureLocalLogSheet(
  serverSheet: ServerLogSheet
): Promise<LogSheet> {
  const serverId = toIdString(serverSheet.id)
  const existing = await getLogSheetByServerId(serverId)
  if (existing) {
    const needsEntries = !existing.entries || existing.entries.length === 0
    const templateId = toIdString(serverSheet.templateId) || existing.templateId
    const rebuiltEntries = needsEntries && templateId
      ? await buildEntriesForTemplate(templateId)
      : undefined

    const revival = revivalUpdatesAfterReassign(existing)

    await updateLogSheet(existing.localId, {
      serverStatus: serverSheet.status ?? existing.serverStatus,
      assignmentType: serverSheet.assignmentType ?? existing.assignmentType,
      dueAt: serverSheet.dueAt ?? existing.dueAt,
      scopeSummary: serverSheet.scopeSummary ?? existing.scopeSummary,
      templateName: serverSheet.templateName ?? existing.templateName,
      operationalUnitId: toIdString(serverSheet.operationalUnitId) || existing.operationalUnitId,
      ...(rebuiltEntries && rebuiltEntries.length > 0 ? { entries: rebuiltEntries } : {}),
      ...revival
    })
    const updated = await getLogSheetByServerId(serverId)
    if (updated) return updated
    return existing
  }

  const templateId = toIdString(serverSheet.templateId)
  const entries = templateId ? await buildEntriesForTemplate(templateId) : []
  const settings = await getSettings()
  const now = Date.now()
  const localId = serverSheet.localId ?? uuidv4()

  return saveLogSheet({
    localId,
    serverId,
    templateId,
    templateName: serverSheet.templateName ?? '',
    scopeSummary: serverSheet.scopeSummary ?? '',
    operationalUnitId: toIdString(serverSheet.operationalUnitId) || undefined,
    operatorName: serverSheet.operatorName ?? (settings.operatorName || undefined),
    status: 'draft',
    serverStatus: serverSheet.status ?? undefined,
    assignmentType: serverSheet.assignmentType ?? undefined,
    dueAt: serverSheet.dueAt ?? undefined,
    entries,
    createdAt: serverSheet.createdAt ?? now,
    updatedAt: serverSheet.updatedAt ?? now
  })
}

/** Provision local copies (with asset entries) and merge inbox metadata for assigned sheets. */
export async function mergeInboxIntoLocalSheets(assigned: ServerLogSheet[]): Promise<void> {
  const now = Date.now()
  for (const serverSheet of assigned) {
    await ensureLocalLogSheet(serverSheet)

    const serverId = toIdString(serverSheet.id)
    const local = await getLogSheetByServerId(serverId)
    if (!local) continue

    const dueAt = serverSheet.dueAt ?? local.dueAt
    const serverStatus = serverSheet.status ?? local.serverStatus
    const extended =
      dueAt != null &&
      dueAt > now &&
      serverStatus !== 'EXPIRED'

    const updates: Partial<LogSheet> = {
      dueAt,
      serverStatus,
      templateName: serverSheet.templateName ?? local.templateName,
      scopeSummary: serverSheet.scopeSummary ?? local.scopeSummary,
      assignmentType: serverSheet.assignmentType ?? local.assignmentType,
      ...revivalUpdatesAfterReassign(local)
    }

    if (extended) {
      if (local.serverStatus === 'EXPIRED' || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
        updates.syncError = undefined
        if (local.status === 'submitted' && local.syncStatus === 'failed') {
          updates.syncStatus = 'pending'
        }
      }
    } else if (isLogSheetExpiredForSync({ ...local, dueAt, serverStatus }, now) && local.status === 'submitted') {
      updates.serverStatus = 'EXPIRED'
      updates.syncStatus = 'failed'
      updates.syncError = SYNC_OUTCOME_MESSAGES.EXPIRED
    }

    await updateLogSheet(local.localId, updates)
  }

  await reconcileInboxRevocations(assigned)
  await expireStaleLocalDrafts(now)
}

/** Mark overdue local drafts as expired without treating them as revoked. */
export async function expireStaleLocalDrafts(now = Date.now()): Promise<void> {
  const all = await getAllLogSheets()
  for (const local of all) {
    if (local.status !== 'draft' || !local.serverId) continue
    if (isInvalidLocalLogSheet(local)) continue
    if (!isLogSheetExpired(local, now)) continue
    if (local.serverStatus === 'EXPIRED' && local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
      continue
    }

    await updateLogSheet(local.localId, {
      serverStatus: 'EXPIRED',
      syncError: SYNC_OUTCOME_MESSAGES.EXPIRED
    })
  }
}

/**
 * Local drafts for sheets no longer in the user's inbox were revoked server-side
 * (release / reassign / takeover) while the device was offline.
 */
export async function reconcileInboxRevocations(assigned: ServerLogSheet[]): Promise<void> {
  const assignedIds = new Set(assigned.map(s => toIdString(s.id)))
  const all = await getAllLogSheets()

  for (const local of all) {
    if (local.status !== 'draft' || !local.serverId) continue
    if (local.syncStatus === 'synced') continue
    if (isInvalidLocalLogSheet(local)) continue
    if (isLogSheetExpired(local) || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) continue

    const serverId = toIdString(local.serverId)
    if (assignedIds.has(serverId)) continue

    const wasOpen =
      local.serverStatus === 'ASSIGNED' ||
      local.serverStatus === 'IN_PROGRESS' ||
      local.serverStatus === 'PENDING'

    if (!wasOpen) continue

    await updateLogSheet(local.localId, {
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.REVOKED
    })
  }
}

export function toBatchPayload(sheet: LogSheet): import('@/services/api').LogSheetBatchItem {
  const serverId = sheet.serverId
  if (!serverId) {
    throw new Error('Log sheet server id was not provided.')
  }
  const clientActionId = sheet.clientActionId ?? uuidv4()
  const completedAt = sheet.completedAt ?? sheet.submittedAt ?? Date.now()

  return {
    id: Number(serverId),
    serverId: Number(serverId),
    localId: sheet.localId,
    templateId: sheet.templateId ? Number(sheet.templateId) : undefined,
    templateName: sheet.templateName,
    scopeSummary: sheet.scopeSummary,
    operatorName: sheet.operatorName,
    status: 'SUBMITTED',
    syncStatus: sheet.syncStatus,
    entries: sheet.entries.map(e => ({
      assetId: Number(e.assetId),
      assetName: e.assetName,
      subFunctionCode: e.subFunctionCode,
      subFunctionTag: e.subFunctionTag,
      nfcTagId: e.nfcTagId,
      classId: Number(e.classId),
      formData: e.formData
    })),
    submittedAt: sheet.submittedAt,
    createdAt: sheet.createdAt,
    updatedAt: sheet.updatedAt,
    operationalUnitId: sheet.operationalUnitId
      ? Number(sheet.operationalUnitId)
      : undefined,
    completedAt,
    clientActionId
  }
}
