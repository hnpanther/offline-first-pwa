import { v4 as uuidv4 } from 'uuid'
import {
  getLogSheetTemplate,
  getAssetsInScope,
  getAllSubFunctions,
  getSettings,
  saveLogSheet,
  updateLogSheet,
  getLogSheetByServerId
} from '@/services/storage'
import type { ServerLogSheet } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'
import { toIdString } from '@/utils/ids'
import { isLogSheetExpired, SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'

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
      classId: asset.classId,
      formData: {}
    }
  })
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

    await updateLogSheet(existing.localId, {
      serverStatus: serverSheet.status ?? existing.serverStatus,
      assignmentType: serverSheet.assignmentType ?? existing.assignmentType,
      dueAt: serverSheet.dueAt ?? existing.dueAt,
      scopeSummary: serverSheet.scopeSummary ?? existing.scopeSummary,
      templateName: serverSheet.templateName ?? existing.templateName,
      operationalUnitId: toIdString(serverSheet.operationalUnitId) || existing.operationalUnitId,
      ...(rebuiltEntries && rebuiltEntries.length > 0 ? { entries: rebuiltEntries } : {})
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

/** Merge inbox metadata (dueAt, status) into locally stored open sheets. */
export async function mergeInboxIntoLocalSheets(assigned: ServerLogSheet[]): Promise<void> {
  const now = Date.now()
  for (const serverSheet of assigned) {
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
      assignmentType: serverSheet.assignmentType ?? local.assignmentType
    }

    if (extended) {
      if (local.serverStatus === 'EXPIRED' || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
        updates.syncError = undefined
        if (local.status === 'submitted' && local.syncStatus === 'failed') {
          updates.syncStatus = 'pending'
        }
      }
    } else if (isLogSheetExpired({ dueAt, serverStatus }, now) && local.status === 'submitted') {
      updates.serverStatus = 'EXPIRED'
      updates.syncStatus = 'failed'
      updates.syncError = SYNC_OUTCOME_MESSAGES.EXPIRED
    }

    await updateLogSheet(local.localId, updates)
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
