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
import {
  fetchLogSheetBundle,
  fetchLogSheetEntries,
  type LogSheetBundleDto,
  type ServerLogSheet,
  type ServerLogSheetEntry
} from '@/services/api'
import { mergeBundleContext } from '@/services/sync/mergeBundleContext'
import type { LogSheet, LogSheetEntryData } from '@/types'
import { toIdString } from '@/utils/ids'
import { isLogSheetExpiredForSync, isLogSheetExpired, SYNC_OUTCOME_MESSAGES, isInvalidLocalLogSheet, isOwnershipReassignError } from '@/utils/logSheetStatus'

export interface EnsureLocalLogSheetOptions {
  /** When true, pull the authoritative bundle from the server. */
  refreshEntriesOnline?: boolean
  /** Pre-loaded entries from an inbox/claim bundle — skips network. */
  serverEntries?: ServerLogSheetEntry[]
}

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

function mapServerEntry(
  entry: ServerLogSheetEntry,
  formData: Record<string, unknown>
): LogSheetEntryData {
  return {
    assetId: toIdString(entry.assetId),
    assetName: entry.assetName ?? '',
    subFunctionCode: entry.subFunctionCode ?? '',
    subFunctionTag: entry.subFunctionTag ?? '',
    nfcTagId: entry.nfcTagId ?? undefined,
    classId: toIdString(entry.classId),
    formData
  }
}

function mapServerEntries(
  serverEntries: ServerLogSheetEntry[],
  existingEntries?: LogSheetEntryData[]
): LogSheetEntryData[] {
  const formByAsset = new Map(
    (existingEntries ?? []).map(entry => [toIdString(entry.assetId), entry.formData ?? {}])
  )
  return serverEntries.map(entry =>
    mapServerEntry(entry, formByAsset.get(toIdString(entry.assetId)) ?? entry.formData ?? {})
  )
}

/** Pull authoritative rows from the server and keep any local form values for matching assets. */
export async function refreshEntriesFromServer(
  serverId: number | string,
  existingEntries?: LogSheetEntryData[]
): Promise<LogSheetEntryData[]> {
  const serverEntries = await fetchLogSheetEntries(serverId)
  return mapServerEntries(serverEntries, existingEntries)
}

/** Pull full bundle (entries + scoped context) and merge local form values. */
export async function refreshFromBundle(
  serverId: number | string,
  existingEntries?: LogSheetEntryData[]
): Promise<LogSheetEntryData[]> {
  const bundle = await fetchLogSheetBundle(serverId)
  if (bundle.context) {
    await mergeBundleContext(bundle.context)
  }
  if (!bundle.entries || bundle.entries.length === 0) {
    return refreshEntriesFromServer(serverId, existingEntries)
  }
  return mapServerEntries(bundle.entries, existingEntries)
}

async function resolveEntries(
  serverSheet: ServerLogSheet,
  existingEntries: LogSheetEntryData[] | undefined,
  options?: EnsureLocalLogSheetOptions
): Promise<LogSheetEntryData[] | undefined> {
  const templateId = toIdString(serverSheet.templateId)
  const needsEntries = !existingEntries || existingEntries.length === 0

  if (options?.serverEntries && options.serverEntries.length > 0) {
    return mapServerEntries(options.serverEntries, existingEntries)
  }

  if (options?.refreshEntriesOnline) {
    try {
      const refreshed = await refreshFromBundle(serverSheet.id, existingEntries)
      if (refreshed.length > 0) {
        return refreshed
      }
    } catch {
      const refreshed = await refreshEntriesFromServer(serverSheet.id, existingEntries)
      if (refreshed.length > 0) {
        return refreshed
      }
    }
  }

  if (needsEntries && templateId) {
    const rebuilt = await buildEntriesForTemplate(templateId)
    if (rebuilt.length > 0) {
      return rebuilt
    }
  }

  return undefined
}

/** User was reassigned away earlier; server put the sheet back in their inbox. */
function revivalUpdatesAfterReassign(local: LogSheet): Partial<LogSheet> | null {
  if (!isOwnershipReassignError(local.syncError)) return null
  const updates: Partial<LogSheet> = { syncError: undefined }
  if (local.syncStatus === 'failed' || (local.status === 'submitted' && local.syncStatus !== 'synced')) {
    updates.syncStatus = 'pending'
  }
  if (local.status === 'submitted') {
    updates.clientActionId = uuidv4()
  }
  return updates
}

export async function ensureLocalLogSheet(
  serverSheet: ServerLogSheet,
  options?: EnsureLocalLogSheetOptions
): Promise<LogSheet> {
  const serverId = toIdString(serverSheet.id)
  const existing = await getLogSheetByServerId(serverId)
  if (existing) {
    const resolvedEntries = await resolveEntries(
      serverSheet,
      existing.entries,
      options
    )
    const revival = revivalUpdatesAfterReassign(existing)

    await updateLogSheet(existing.localId, {
      serverStatus: serverSheet.status ?? existing.serverStatus,
      assignmentType: serverSheet.assignmentType ?? existing.assignmentType,
      dueAt: serverSheet.dueAt ?? existing.dueAt,
      scopeSummary: serverSheet.scopeSummary ?? existing.scopeSummary,
      templateName: serverSheet.templateName ?? existing.templateName,
      operationalUnitId: toIdString(serverSheet.operationalUnitId) || existing.operationalUnitId,
      ...(resolvedEntries && resolvedEntries.length > 0 ? { entries: resolvedEntries } : {}),
      ...revival
    })
    const updated = await getLogSheetByServerId(serverId)
    if (updated) return updated
    return existing
  }

  const templateId = toIdString(serverSheet.templateId)
  const entries =
    (await resolveEntries(serverSheet, undefined, options)) ??
    (templateId ? await buildEntriesForTemplate(templateId) : [])
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

export async function ensureLocalLogSheetFromBundle(
  bundle: LogSheetBundleDto,
  options?: Omit<EnsureLocalLogSheetOptions, 'serverEntries'>
): Promise<LogSheet> {
  if (bundle.context) {
    await mergeBundleContext(bundle.context)
  }
  return ensureLocalLogSheet(bundle.sheet, {
    ...options,
    serverEntries: bundle.entries ?? undefined,
    refreshEntriesOnline: false
  })
}

export interface MergeInboxOptions {
  refreshEntriesOnline?: boolean
}

/** Provision local copies (with asset entries) and merge inbox metadata for assigned sheets. */
export async function mergeInboxIntoLocalSheets(
  assigned: LogSheetBundleDto[],
  options?: MergeInboxOptions
): Promise<void> {
  const now = Date.now()
  for (const bundle of assigned) {
    await ensureLocalLogSheetFromBundle(bundle, {
      refreshEntriesOnline: options?.refreshEntriesOnline
    })

    const serverSheet = bundle.sheet
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

  await reconcileInboxRevocations(assigned.map(bundle => bundle.sheet))
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
