import { v4 as uuidv4 } from 'uuid'
import {
  saveLogSheet,
  updateLogSheet,
  getLogSheetByServerId,
  getAllLogSheets,
  resetLogSheetToOpenDraft
} from '@/services/storage'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { peekAuthSession } from '@/services/auth'
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
  normalizeFieldDefinitions,
  bundleScopeDisplayLabel
} from '@/services/sync/mergeLogSheetBundle'
import {
  alignLocalWorkflowWithServer,
  shouldPreserveLocalFormData,
  shouldArchiveBeforeServerOverwrite,
  revivalUpdatesAfterReassign,
  resolveReopenedSheetUpdates
} from '@/utils/logSheetWorkflow'

export interface EnsureLocalLogSheetOptions {
  /** When online, fetch the latest bundle from the server before opening. */
  refreshBundleOnline?: boolean
}

/** Apply a server bundle: refresh context in IndexedDB (server wins) and upsert local sheet. */
/**
 * Display name for a sheet the server did not label.
 *
 * Only reached when `serverSheet.operatorName` is absent; the sheet is being
 * materialised for whoever is signed in on this device, so their own name is the
 * right label. This used to read a device-wide name typed into Settings, which on
 * a shared tablet attributed every operator's work to whatever the admin typed once.
 */
async function currentUserDisplayName(): Promise<string | undefined> {
  const session = await peekAuthSession()
  return session?.fullName || session?.username || undefined
}

export async function applyLogSheetBundle(bundle: LogSheetBundleDto): Promise<LogSheet> {
  await mergeBundleContextToDb(bundle.context)

  const serverSheet = bundle.sheet
  const serverId = toIdString(serverSheet.id)
  const existing = await getLogSheetByServerId(serverId)

  // A still-unsynced completed submission must be resolved only by the batch-submit
  // outcome (server-authoritative: SUBMITTED/DUPLICATE, or SUPERSEDED with a server-side
  // void record on conflict). A bundle refresh has no way to inform the server this work
  // ever happened, so it must never overwrite this sheet's assignee, entries, or status —
  // doing so silently discards the operator's completed work with no error and no void
  // record, since the batch-submit endpoint never gets a chance to see it. Leave it exactly
  // as the operator left it; the outbound sync queue resolves it on its own.
  if (existing && existing.status === 'submitted' && existing.syncStatus === 'pending') {
    return existing
  }

  const sessionUserId = await getSessionUserId()
  const workflow = existing ? alignLocalWorkflowWithServer(existing, serverSheet) : null
  const preserveLocal =
    workflow !== 'reset-draft' &&
    shouldPreserveLocalFormData(existing, serverSheet, sessionUserId)
  // Whether this device's own edits still stand for something.
  //
  // Once the row is `submitted` + `synced` the work has been delivered and reconciled: what the
  // device holds came from the server, so a `locallyEditedAt` marker still sitting on an entry
  // describes an opinion that no longer exists. Honouring it would hand the device that entry on
  // every future merge — and this is exactly the state a sheet is in when a supervisor reopens
  // it, edits it and hands it back, so the cost would be the supervisor's readings going
  // invisible all over again.
  //
  // Markers are also cleared outright when a submission is accepted; this gate is the second
  // lock on the same door, because the failure it prevents is silent.
  const localEditsPending = !(existing?.status === 'submitted' && existing?.syncStatus === 'synced')
  const entries = mergeEntriesPreservingFormData(bundle.entries ?? [], existing?.entries, {
    preserveLocal,
    localEditsPending
  })
  const scopeDisplayLabel = bundleScopeDisplayLabel(bundle)
  // Freeze this bundle's schema onto the sheet. The shared per-class table cannot express
  // "sheet A's Pump schema differs from sheet B's", which it must, because the server sends
  // each sheet's own field_definitions_snapshot. An empty list means the bundle carried none
  // — keep whatever the sheet already had rather than blanking a working form.
  const bundleFieldDefinitions = normalizeFieldDefinitions(bundle.context?.fieldDefinitions ?? [])
  const fieldDefinitionsPatch = bundleFieldDefinitions.length > 0
    ? { fieldDefinitions: bundleFieldDefinitions }
    : {}

  if (existing) {
    if (workflow === 'reset-draft') {
      await archiveLocalWorkBeforeClear(existing)
      await resetLogSheetToOpenDraft(existing.localId, { clearEntryFormData: true })
      const reset = await getLogSheetByServerId(serverId)
      if (reset) {
        await updateLogSheet(reset.localId, {
          ...serverSheetMetadataPatch(serverSheet, reset),
          entries,
          ...fieldDefinitionsPatch,
          localOwnerUserId: undefined,
          ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
        })
        const updated = await getLogSheetByServerId(serverId)
        if (updated) return updated
      }
    } else if (workflow === 'mark-synced') {
      // The server sheet is SUBMITTED. When that completion is *not* this local row's
      // work (`preserveLocal === false`), the operator's own readings are about to be
      // replaced by the server's values — keep a read-only copy first, exactly like the
      // reset-draft branch does. Without this an operator who filled a few assets but
      // never hit final submit loses everything the moment they reopen the sheet, and
      // the live row (now `synced`) is purged by cleanupLocalLogSheets a day later.
      const discardsLocalWork = shouldArchiveBeforeServerOverwrite(existing, preserveLocal)
      if (discardsLocalWork) {
        await archiveLocalWorkBeforeClear(existing)
      }
      await updateLogSheet(existing.localId, {
        ...serverSheetMetadataPatch(serverSheet, existing),
        ...fieldDefinitionsPatch,
        status: 'submitted',
        syncStatus: 'synced',
        serverStatus: 'SUBMITTED',
        syncError: undefined,
        syncedAt: existing.syncedAt ?? Date.now(),
        entries,
        // This row now mirrors someone else's completion, so it is no longer this
        // user's local work. Releasing the claim (same as the reset-draft branch) also
        // stops loadLogSheetsForSessionUser from treating the snapshot above as a
        // stale duplicate of an "owned, synced" row and deleting it.
        ...(discardsLocalWork ? { localOwnerUserId: undefined } : {}),
        ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
      })
      // Only drop a stale archive when this row really is the user's *own* confirmed
      // submission (`preserveLocal`) — never the snapshot taken above. Gating on
      // `discardsLocalWork` instead would still delete it on the next pass, once the
      // row is reconciled and nothing is left to archive.
      if (sessionUserId && preserveLocal) {
        await removeArchivedLogSheet(serverId, sessionUserId)
      }
      const updated = await getLogSheetByServerId(serverId)
      if (updated) return updated
      return existing
    }

    await updateLogSheet(existing.localId, {
      ...serverSheetMetadataPatch(serverSheet, existing),
      entries,
      ...fieldDefinitionsPatch,
      ...(scopeDisplayLabel ? { scopeDisplayLabel } : {})
    })
    const updated = await getLogSheetByServerId(serverId)
    if (updated) return updated
    return existing
  }

  const fallbackOperatorName = await currentUserDisplayName()
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
    operatorName: serverSheet.operatorName ?? fallbackOperatorName,
    assigneeUserId:
      serverSheet.assigneeUserId != null ? toIdString(serverSheet.assigneeUserId) : undefined,
    status: 'draft',
    serverStatus: serverSheet.status ?? undefined,
    assignmentType: serverSheet.assignmentType ?? undefined,
    dueAt: serverSheet.dueAt ?? undefined,
    entries,
    ...fieldDefinitionsPatch,
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
    const fallbackOperatorName = await currentUserDisplayName()
    const now = Date.now()
    const localId = serverSheet.localId ?? uuidv4()
    return saveLogSheet({
      localId,
      serverId,
      templateId: toIdString(serverSheet.templateId),
      templateName: serverSheet.templateName ?? '',
      scopeSummary: serverSheet.scopeSummary ?? '',
      operationalUnitId: toIdString(serverSheet.operationalUnitId) || undefined,
      operatorName: serverSheet.operatorName ?? fallbackOperatorName,
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
      // The sheet reaching this point at all means it's currently in this operator's own
      // "assigned" inbox bucket with a future dueAt — genuinely reopened. See
      // resolveReopenedSheetUpdates for exactly which stale flags this clears and why.
      Object.assign(updates, resolveReopenedSheetUpdates(local, () => uuidv4()))
    } else if (
      local.status === 'submitted' &&
      local.syncStatus === 'failed' &&
      // serverStatus is the reliable signal — syncError may instead hold the backend's own
      // translated message rather than this client's SYNC_OUTCOME_MESSAGES.EXPIRED text.
      (local.serverStatus === 'EXPIRED' || local.syncError === SYNC_OUTCOME_MESSAGES.EXPIRED) &&
      completedWithinDeadline(local)
    ) {
      updates.syncError = undefined
      updates.syncStatus = 'pending'
      updates.clientActionId = uuidv4()
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
 *
 * Known ambiguity: a sheet can disappear from the inbox because it was released/reassigned
 * OR because it was cancelled — the inbox response gives no reason, only absence, so this
 * still (correctly, safely) blocks further edits either way but may show the REVOKED wording
 * even when the true cause was a cancel. The precise CANCELLED state/message only becomes
 * known once the client learns it directly: opening the sheet online (see
 * alignLocalWorkflowWithServer) or via a batch-submit CANCELLED outcome. Once the local
 * cache already reflects `serverStatus === 'CANCELLED'` this function no longer fires for
 * it at all (guarded by the status allow-list below), so it never overwrites a sheet the
 * client already correctly knows is cancelled.
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
      nfcSerial: e.nfcSerial,
      classId: Number(e.classId),
      formData: e.formData,
      ...(e.createdAt != null ? { createdAt: e.createdAt } : {}),
      ...(e.updatedAt != null ? { updatedAt: e.updatedAt } : {}),
      ...(e.filledVia != null ? { manualEntry: e.filledVia === 'manual' } : {})
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
