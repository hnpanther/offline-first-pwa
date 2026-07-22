import { v4 as uuidv4 } from 'uuid'
import {
  getSettings,
  saveLogSheet,
  updateLogSheet,
  getLogSheetByServerId,
  getAllLogSheets,
  resetLogSheetToOpenDraft
} from '@/services/storage'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { archiveLocalWorkBeforeClear, removeArchivedLogSheet } from '@/services/storage/logSheetArchive'
import {
  fetchLogSheetBundle,
  type LogSheetBundleDto,
  type ServerLogSheet
} from '@/services/api'
import type { LogSheet } from '@/types'
import { toIdString } from '@/utils/ids'
import { isLogSheetExpiredForSync, isLogSheetExpired, SYNC_OUTCOME_MESSAGES, isInvalidLocalLogSheet, completedWithinDeadline } from '@/utils/logSheetStatus'
import {
  mergeBundleContextToDb,
  mergeEntriesPreservingFormData,
  bundleScopeDisplayLabel
} from '@/services/sync/mergeLogSheetBundle'
import {
  alignLocalWorkflowWithServer,
  shouldPreserveLocalFormData,
  revivalUpdatesAfterReassign
} from '@/utils/logSheetWorkflow'

export interface EnsureLocalLogSheetOptions {
  /** When online, fetch the latest bundle from the server before opening. */
  refreshBundleOnline?: boolean
}

/** Apply a server bundle: refresh context in IndexedDB (server wins) and upsert local sheet. */
export async function applyLogSheetBundle(bundle: LogSheetBundleDto): Promise<LogSheet> {
  await mergeBundleContextToDb(bundle.context)

  const serverSheet = bundle.sheet
  const serverId = toIdString(serverSheet.id)
  const existing = await getLogSheetByServerId(serverId)
  const sessionUserId = await getSessionUserId()
  const workflow = existing ? alignLocalWorkflowWithServer(existing, serverSheet) : null
  const preserveLocal =
    workflow !== 'reset-draft' &&
    shouldPreserveLocalFormData(existing, serverSheet, sessionUserId)
  const entries = mergeEntriesPreservingFormData(bundle.entries ?? [], existing?.entries, {
    preserveLocal
  })
  const scopeDisplayLabel = bundleScopeDisplayLabel(bundle)

  if (existing) {
    if (workflow === 'reset-draft') {
      await archiveLocalWorkBeforeClear(existing)
      await resetLogSheetToOpenDraft(existing.localId, { clearEntryFormData: true })
      const reset = await getLogSheetByServerId(serverId)
      if (reset) {
        await updateLogSheet(reset.localId, {
          ...serverSheetMetadataPatch(serverSheet, reset),
          entries,
          localOwnerUserId: undefined,
          ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
        })
        const updated = await getLogSheetByServerId(serverId)
        if (updated) return updated
      }
    } else if (workflow === 'mark-synced') {
      await updateLogSheet(existing.localId, {
        ...serverSheetMetadataPatch(serverSheet, existing),
        status: 'submitted',
        syncStatus: 'synced',
        serverStatus: 'SUBMITTED',
        syncError: undefined,
        syncedAt: existing.syncedAt ?? Date.now(),
        entries,
        ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
      })
      if (sessionUserId) {
        await removeArchivedLogSheet(serverId, sessionUserId)
      }
      const updated = await getLogSheetByServerId(serverId)
      if (updated) return updated
      return existing
    }

    await updateLogSheet(existing.localId, {
      ...serverSheetMetadataPatch(serverSheet, existing),
      entries,
      ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
    })
    const updated = await getLogSheetByServerId(serverId)
    if (updated) return updated
    return existing
  }

  const settings = await getSettings()
  const now = Date.now()
  const localId = serverSheet.localId ?? uuidv4()

  return saveLogSheet({
    localId,
    serverId,
    templateId: toIdString(serverSheet.templateId),
    templateName: serverSheet.templateName ?? '',
    scopeSummary: serverSheet.scopeSummary ?? '',
    scopeDisplayLabel,
    operationalUnitId: toIdString(serverSheet.operationalUnitId) || undefined,
    operatorName: serverSheet.operatorName ?? (settings.operatorName || undefined),
    assigneeUserId:
      serverSheet.assigneeUserId != null ? toIdString(serverSheet.assigneeUserId) : undefined,
    status: 'draft',
    serverStatus: serverSheet.status ?? undefined,
    assignmentType: serverSheet.assignmentType ?? undefined,
    dueAt: serverSheet.dueAt ?? undefined,
    entries,
    createdAt: serverSheet.createdAt ?? now,
    updatedAt: serverSheet.updatedAt ?? now
  })
}

async function fetchAndApplyBundle(serverId: number | string): Promise<LogSheet> {
  const bundle = await fetchLogSheetBundle(serverId)
  return applyLogSheetBundle(bundle)
}

function serverSheetMetadataPatch(
  serverSheet: ServerLogSheet,
  existing: LogSheet,
  extra?: Partial<LogSheet>
): Partial<LogSheet> {
  return {
    serverStatus: serverSheet.status ?? existing.serverStatus,
    assignmentType: serverSheet.assignmentType ?? existing.assignmentType,
    dueAt: serverSheet.dueAt ?? existing.dueAt,
    scopeSummary: serverSheet.scopeSummary ?? existing.scopeSummary,
    templateName: serverSheet.templateName ?? existing.templateName,
    operationalUnitId: toIdString(serverSheet.operationalUnitId) || existing.operationalUnitId,
    templateId: toIdString(serverSheet.templateId) || existing.templateId,
    operatorName: serverSheet.operatorName ?? existing.operatorName,
    assigneeUserId:
      serverSheet.assigneeUserId != null
        ? toIdString(serverSheet.assigneeUserId)
        : existing.assigneeUserId,
    ...(revivalUpdatesAfterReassign(existing, serverSheet, () => uuidv4()) ?? {}),
    ...extra
  }
}

export async function ensureLocalLogSheet(
  serverSheet: ServerLogSheet,
  options?: EnsureLocalLogSheetOptions
): Promise<LogSheet> {
  const serverId = toIdString(serverSheet.id)

  if (options?.refreshBundleOnline) {
    try {
      return await fetchAndApplyBundle(serverId)
    } catch {
      // Fall through to local cache when server is unreachable.
    }
  }

  const existing = await getLogSheetByServerId(serverId)
  if (existing) {
    await updateLogSheet(existing.localId, serverSheetMetadataPatch(serverSheet, existing))
    const updated = await getLogSheetByServerId(serverId)
    if (updated) return updated
    return existing
  }

  if (options?.refreshBundleOnline === false) {
    const settings = await getSettings()
    const now = Date.now()
    const localId = serverSheet.localId ?? uuidv4()
    return saveLogSheet({
      localId,
      serverId,
      templateId: toIdString(serverSheet.templateId),
      templateName: serverSheet.templateName ?? '',
      scopeSummary: serverSheet.scopeSummary ?? '',
      operationalUnitId: toIdString(serverSheet.operationalUnitId) || undefined,
      operatorName: serverSheet.operatorName ?? (settings.operatorName || undefined),
      assigneeUserId:
        serverSheet.assigneeUserId != null ? toIdString(serverSheet.assigneeUserId) : undefined,
      status: 'draft',
      serverStatus: serverSheet.status ?? undefined,
      assignmentType: serverSheet.assignmentType ?? undefined,
      dueAt: serverSheet.dueAt ?? undefined,
      entries: [],
      createdAt: serverSheet.createdAt ?? now,
      updatedAt: serverSheet.updatedAt ?? now
    })
  }

  return fetchAndApplyBundle(serverId)
}

export interface MergeInboxOptions {
  /** Ignored — assigned bundles always include fresh server context. */
  refreshEntriesOnline?: boolean
}

/** Provision local copies from inbox assigned bundles (always refresh server context). */
export async function mergeInboxIntoLocalSheets(
  assigned: LogSheetBundleDto[],
  _options?: MergeInboxOptions
): Promise<void> {
  const now = Date.now()
  const assignedSheets: ServerLogSheet[] = []

  for (const bundle of assigned) {
    await applyLogSheetBundle(bundle)
    assignedSheets.push(bundle.sheet)

    const serverId = toIdString(bundle.sheet.id)
    const local = await getLogSheetByServerId(serverId)
    if (!local) continue

    const dueAt = bundle.sheet.dueAt ?? local.dueAt
    const serverStatus = bundle.sheet.status ?? local.serverStatus
    const extended =
      dueAt != null &&
      dueAt > now &&
      serverStatus !== 'EXPIRED'

    const updates: Partial<LogSheet> = {
      dueAt,
      serverStatus,
      templateName: bundle.sheet.templateName ?? local.templateName,
      scopeSummary: bundle.sheet.scopeSummary ?? local.scopeSummary,
      assignmentType: bundle.sheet.assignmentType ?? local.assignmentType,
      operatorName: bundle.sheet.operatorName ?? local.operatorName,
      assigneeUserId:
        bundle.sheet.assigneeUserId != null
          ? toIdString(bundle.sheet.assigneeUserId)
          : local.assigneeUserId,
      ...revivalUpdatesAfterReassign(local, bundle.sheet, () => uuidv4())
    }

    if (extended) {
      if (local.serverStatus === 'EXPIRED' || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) {
        updates.syncError = undefined
        if (local.status === 'submitted' && local.syncStatus === 'failed') {
          updates.syncStatus = 'pending'
        }
      }
    } else if (
      local.status === 'submitted' &&
      local.syncStatus === 'failed' &&
      local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED &&
      completedWithinDeadline(local)
    ) {
      updates.syncError = undefined
      updates.syncStatus = 'pending'
    } else if (isLogSheetExpiredForSync({ ...local, dueAt, serverStatus }, now) && local.status === 'submitted') {
      updates.serverStatus = 'EXPIRED'
      updates.syncStatus = 'failed'
      updates.syncError = SYNC_OUTCOME_MESSAGES.EXPIRED
    }

    await updateLogSheet(local.localId, updates)
  }

  await reconcileInboxRevocations(assignedSheets)
  await expireStaleLocalDrafts(now)
}

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

export async function reconcileInboxRevocations(assigned: ServerLogSheet[]): Promise<void> {
  const assignedIds = new Set(assigned.map(s => toIdString(s.id)))
  const all = await getAllLogSheets()

  for (const local of all) {
    if (!shouldMarkDraftRevokedForMissingInbox(local, assignedIds)) continue

    await updateLogSheet(local.localId, {
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.REVOKED
    })
  }
}

/**
 * Only open drafts that disappeared from the assigned inbox are treated as revoked.
 * Submitted+pending sheets must NOT be revoked here: after a successful server submit they
 * also leave the inbox, and marking them REVOKED races with outbound sync (false
 * "واگذار شده به اپراتور دیگر" until the user opens the sheet and refreshes from bundle).
 * Real ownership loss for submitted work is handled by batch submit outcomes instead.
 */
export function shouldMarkDraftRevokedForMissingInbox(
  local: Pick<LogSheet, 'serverId' | 'status' | 'syncStatus' | 'serverStatus' | 'syncError'>,
  assignedIds: ReadonlySet<string>
): boolean {
  if (!local.serverId) return false
  if (local.status !== 'draft') return false
  if (local.syncStatus === 'synced') return false
  if (isInvalidLocalLogSheet(local)) return false
  if (isLogSheetExpired(local) || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) return false

  const serverId = toIdString(local.serverId)
  if (assignedIds.has(serverId)) return false

  return (
    local.serverStatus === 'ASSIGNED' ||
    local.serverStatus === 'IN_PROGRESS' ||
    local.serverStatus === 'PENDING'
  )
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
      formData: e.formData,
      ...(e.createdAt != null ? { createdAt: e.createdAt } : {}),
      ...(e.updatedAt != null ? { updatedAt: e.updatedAt } : {})
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
