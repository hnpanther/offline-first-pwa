import type { FormSubmissionDto } from '@/services/api'
import { attachmentIdsOf, attachmentKindForDataType, removeAttachment } from './attachments'
import { serverNow } from '@/services/clock/serverClock'
import { v4 as uuidv4 } from 'uuid'
import { db } from '@/services/storage/db'
import { getSessionUserId } from '@/services/auth/sessionContext'
import type { FieldDefinition } from '@/types/sync'
import {
  coerceFormSubmissionServerStatus,
  type LocalFormSubmission,
  type SyncStatus
} from '@/types'
import { isFormSubmissionVisibleToSession } from '@/utils/formSubmissionVisibility'

/**
 * Whether this form submission may be pushed under the signed-in user.
 *
 * Fourth outbound-owned table — same rule as NFC fault reports and attachment rows:
 * a shared tablet keeps every user's undelivered work, and only the owner may deliver it.
 */
export function isFormSubmissionOutboundOwnedByUser(
  row: Pick<LocalFormSubmission, 'createdByUserId'>,
  userId: string | null
): boolean {
  if (!userId) return false
  if (!row.createdByUserId) return true
  return row.createdByUserId === userId
}

/** Draft upsert lane — open drafts this operator dirtied, not yet mirrored / remirrored. */
export function isFormDraftOwnedByUser(
  row: Pick<LocalFormSubmission, 'status' | 'createdByUserId' | 'locallyEditedAt' | 'draftSyncedAt' | 'syncConflict'>,
  userId: string | null
): boolean {
  if (!isFormSubmissionOutboundOwnedByUser(row, userId)) return false
  if (row.status !== 'draft' || row.syncConflict) return false
  if (row.locallyEditedAt == null) return false
  // Already mirrored at this exact edit stamp — wait for a newer save.
  if (row.draftSyncedAt != null && row.draftSyncedAt >= row.locallyEditedAt) return false
  return true
}

/** Final-submit lane — finished work waiting for a server outcome. */
export function isFormFinalOwnedByUser(
  row: Pick<LocalFormSubmission, 'status' | 'syncStatus' | 'lastSubmitOutcome' | 'createdByUserId' | 'clientActionId' | 'syncConflict'>,
  userId: string | null
): boolean {
  if (!isFormSubmissionOutboundOwnedByUser(row, userId)) return false
  if (row.status !== 'submitted' || row.syncConflict) return false
  if (row.syncStatus === 'failed' && row.lastSubmitOutcome === 'VALIDATION_ERROR') return false
  // SyncManager serializes final passes; syncing may survive an interrupted attempt.
  if (!['pending', 'failed', 'syncing'].includes(row.syncStatus)) return false
  return true
}

export async function getFormSubmission(localId: string): Promise<LocalFormSubmission | undefined> {
  return db.formSubmissions.where('localId').equals(localId).first()
}

export async function getFormSubmissionById(id: string): Promise<LocalFormSubmission | undefined> {
  return db.formSubmissions.get(id)
}

/**
 * Personal list for the signed-in operator, scoped to accessible units.
 *
 * Unit filter is load-bearing on a shared tablet: IndexedDB holds every operator's
 * rows, and cross-unit filing stores a foreign `subjectUnitId` without granting
 * that other unit's operators a view of the row on this device.
 */
export async function getFormSubmissionsForUser(
  userId: string | null,
  opts?: {
    accessibleUnitIds?: ReadonlySet<string> | Iterable<string>
    plantWide?: boolean
  }
): Promise<LocalFormSubmission[]> {
  const all = await db.formSubmissions.orderBy('createdAt').reverse().toArray()
  const accessibleUnitIds = opts?.accessibleUnitIds ?? []
  const plantWide = opts?.plantWide === true
  return all.filter(r =>
    isFormSubmissionVisibleToSession(r, { userId, accessibleUnitIds, plantWide })
  )
}

export async function getAllFormSubmissions(): Promise<LocalFormSubmission[]> {
  return db.formSubmissions.toArray()
}

export async function deleteFormSubmission(localId: string): Promise<void> {
  const row = await getFormSubmission(localId)
  if (!row) return
  await db.formSubmissions.delete(row.id)
}

export async function getPendingFormDrafts(userId: string | null): Promise<LocalFormSubmission[]> {
  const drafts = await db.formSubmissions.where('status').equals('draft').toArray()
  return drafts.filter(r => isFormDraftOwnedByUser(r, userId))
}

export async function getPendingFormFinals(userId: string | null): Promise<LocalFormSubmission[]> {
  const submitted = await db.formSubmissions.where('status').equals('submitted').toArray()
  return submitted.filter(r => isFormFinalOwnedByUser(r, userId))
}

export async function putFormSubmission(row: LocalFormSubmission): Promise<void> {
  await db.formSubmissions.put(row)
}

export async function updateFormSubmission(
  localId: string,
  patch: Partial<LocalFormSubmission>
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return
    await db.formSubmissions.put({ ...existing, ...patch, updatedAt: Date.now() })
  })
}

export async function createLocalFormDraft(input: {
  lastSavedByName?: string
  recordedAt?: number
  schemaVersionId?: string
  formDefinitionId: string
  formCode?: string
  formTitle?: string
  reporterUnitId: string
  subjectUnitId: string
  fieldDefinitionsSnapshot: FieldDefinition[]
  formData?: Record<string, unknown>
}): Promise<LocalFormSubmission> {
  const createdByUserId = await getSessionUserId()
  const now = Date.now()
  const localId = uuidv4()
  const row: LocalFormSubmission = {
    id: localId,
    localId,
    formDefinitionId: input.formDefinitionId,
    schemaVersionId: input.schemaVersionId,
    lastSavedByName: input.lastSavedByName,
    formCode: input.formCode,
    formTitle: input.formTitle,
    reporterUnitId: input.reporterUnitId,
    subjectUnitId: input.subjectUnitId,
    status: 'draft',
    formData: input.formData ?? {},
    fieldDefinitionsSnapshot: input.fieldDefinitionsSnapshot,
    draftClientActionId: uuidv4(),
    syncStatus: 'pending',
    locallyEditedAt: now,
    draftSyncStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    deviceTimeAt: input.recordedAt ?? serverNow(),
    ...(createdByUserId ? { createdByUserId } : {})
  }
  await db.formSubmissions.add(row)
  return row
}

/** Run inside the answer write transaction, including when a signature was cleared/replaced. */
async function reconcileRemovedMedia(form: LocalFormSubmission, next: Record<string, unknown>) {
  const local = await db.attachments.where('formSubmissionLocalId').equals(form.localId).toArray()
  for (const file of local) {
    if (file.createdByUserId && file.createdByUserId !== form.createdByUserId) continue
    if (file.pendingDelete) {
      if (attachmentIdsOf(next[file.fieldKey]).includes(file.id)) {
        await db.attachments.update(file.id, { pendingDelete: false })
      }
      continue
    }
    const before = attachmentIdsOf(form.formData?.[file.fieldKey])
    if (before.includes(file.id) && !attachmentIdsOf(next[file.fieldKey]).includes(file.id)) {
      await removeAttachment(file.id)
    }
  }
  // Reopened drafts can name server files that this tablet never downloaded.
  if (!form.serverId) return
  for (const field of form.fieldDefinitionsSnapshot ?? []) {
    const kind = attachmentKindForDataType(field.dataType)
    if (!kind) continue
    const kept = attachmentIdsOf(next[field.key])
    for (const id of attachmentIdsOf(form.formData[field.key])) {
      if (kept.includes(id) || await db.attachments.get(id)) continue
      await db.attachments.add({
        id, fieldKey: field.key, kind, formSubmissionLocalId: form.localId,
        formSubmissionId: form.serverId, createdByUserId: form.createdByUserId,
        createdAt: Date.now(), syncStatus: 'synced', pendingDelete: true, sizeBytes: 0, mimeType: ''
      })
    }
  }
}

export async function saveLocalFormDraft(
  localId: string,
  formData: Record<string, unknown>,
  reporterUnitId?: string,
  recordedAt = serverNow(),
  saverName?: string,
  displayed?: LocalFormSubmission
): Promise<LocalFormSubmission | undefined> {
  return db.transaction('rw', db.formSubmissions, db.attachments, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return
    const finalizedWhileOpen = displayed?.status === 'draft' && existing.status === 'submitted' &&
      existing.syncStatus === 'synced'
    if (existing.status !== 'draft' && !finalizedWhileOpen) return existing
    // A clean draft can be refreshed from history while its editor still displays older answers.
    const changedBehindEditor = finalizedWhileOpen || (displayed && existing.serverUpdatedAt !== displayed.serverUpdatedAt &&
      (existing.reporterUnitId !== displayed.reporterUnitId ||
        JSON.stringify(existing.formData) !== JSON.stringify(displayed.formData)))
    if (!changedBehindEditor && !existing.syncConflict) await reconcileRemovedMedia(existing, formData)
    const now = Math.max(Date.now(), (existing.locallyEditedAt ?? 0) + 1, (existing.draftSyncedAt ?? 0) + 1)
    const next: LocalFormSubmission = {
      ...existing,
      formData,
      draftClientActionId: uuidv4(),
      status: 'draft',
      syncConflict: existing.syncConflict || !!changedBehindEditor,
      lastSavedByName: saverName ?? existing.lastSavedByName,
      reporterUnitId: reporterUnitId ?? existing.reporterUnitId,
      subjectUnitId: reporterUnitId ?? existing.reporterUnitId,
      locallyEditedAt: now,
      draftSyncStatus: 'pending',
      draftSyncError: undefined,
      updatedAt: now,
      deviceTimeAt: recordedAt
    }
    await db.formSubmissions.put(next)
    return next
  })
}

/**
 * Marks the row as locally finalised. Sync delivers it; never invents a server outcome.
 * Required fields must already have been checked by the caller.
 */
export async function markFormSubmissionLocallyFinal(
  localId: string,
  formData: Record<string, unknown>,
  recordedAt = serverNow()
): Promise<LocalFormSubmission | undefined> {
  return db.transaction('rw', db.formSubmissions, db.attachments, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing || existing.status !== 'draft' || existing.syncConflict) return existing
    await reconcileRemovedMedia(existing, formData)
    const now = Date.now()
    const next: LocalFormSubmission = {
      ...existing,
      formData,
      status: 'submitted',
      clientActionId: existing.clientActionId ?? uuidv4(),
      syncStatus: 'pending',
      syncError: undefined,
      submittedAt: now,
      updatedAt: now,
      deviceTimeAt: recordedAt,
      // Final owns delivery from here; draft lane ignores submitted rows.
      locallyEditedAt: undefined,
      draftSyncStatus: existing.draftSyncStatus
    }
    await db.formSubmissions.put(next)
    return next
  })
}

export async function applyFormDraftSyncResult(
  localId: string,
  result: {
    serverId?: string
    outcome: string
    status?: string
    message?: string | null
    updatedAt?: number
    editedAt?: number
  }
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return
    if (existing.syncConflict || (result.updatedAt != null && result.updatedAt < (existing.serverUpdatedAt ?? 0))) return
    if (existing.status !== 'draft') {
      // A local final can be queued while its draft HTTP acknowledgement is in flight.
      if (result.outcome === 'OK' && existing.syncStatus !== 'synced' && result.updatedAt != null &&
          result.updatedAt >= (existing.serverUpdatedAt ?? 0)) {
        await db.formSubmissions.update(existing.id, { serverId: result.serverId, serverUpdatedAt: result.updatedAt })
      }
      return
    }

    if (result.outcome === 'OK') {
      // Conditional clear: only clear dirty if no newer edit landed while the request flew.
      const stillSameEdit =
        result.editedAt != null &&
        existing.locallyEditedAt != null &&
        existing.locallyEditedAt === result.editedAt
      await db.formSubmissions.put({
        ...existing,
        serverId: result.serverId != null ? String(result.serverId) : existing.serverId,
        serverStatus: 'DRAFT',
        serverUpdatedAt: result.updatedAt ?? existing.serverUpdatedAt,
        draftSyncStatus: 'synced',
        draftSyncedAt: stillSameEdit ? existing.locallyEditedAt : existing.draftSyncedAt,
        draftSyncError: undefined,
        updatedAt: Date.now()
      })
      return
    }

    await db.formSubmissions.put({
      ...existing,
      serverId: result.serverId ?? existing.serverId,
      syncConflict: result.outcome === 'CONFLICT' || existing.syncConflict,
      draftSyncStatus: 'failed',
      draftSyncError: result.message ?? result.outcome,
      updatedAt: Date.now()
    })
  })
}

export async function applyFormFinalSyncResult(
  localId: string,
  result: {
    actionId?: string
    updatedAt?: number
    serverId?: string
    outcome: string
    status?: string
    message?: string | null
  }
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return

    if (existing.syncConflict || (result.actionId && result.actionId !== existing.clientActionId) ||
        (result.updatedAt != null && result.updatedAt < (existing.serverUpdatedAt ?? 0))) return
    const accepted = result.outcome === 'OK' || result.outcome === 'DUPLICATE'
    if (accepted) {
      // Prefer the server's status when present (SUBMITTED today; APPROVED/VOIDED later)
      // so a review/void API does not leave the local row disagreeing with the wire.
      const serverStatus =
        coerceFormSubmissionServerStatus(result.status) ??
        existing.serverStatus ??
        'SUBMITTED'
      await db.formSubmissions.put({
        ...existing,
        serverId: result.serverId != null ? String(result.serverId) : existing.serverId,
        serverStatus,
        serverUpdatedAt: result.updatedAt ?? existing.serverUpdatedAt,
        status: 'submitted',
        syncStatus: 'synced',
        syncedAt: Date.now(),
        lastSubmitOutcome: result.outcome,
        syncError: undefined,
        updatedAt: Date.now()
      })
      return
    }

    // Keep the work — never discard. Operator can reopen a VALIDATION_ERROR draft path later.
    await db.formSubmissions.put({
      ...existing,
      syncStatus: 'failed',
      lastSubmitOutcome: result.outcome,
      serverId: result.serverId ?? existing.serverId,
      syncConflict: result.outcome === 'CONFLICT' || existing.syncConflict,
      syncError: result.message ?? result.outcome,
      updatedAt: Date.now()
    })
  })
}

export async function setFormSubmissionSyncStatus(
  localId: string,
  syncStatus: SyncStatus,
  extra?: Partial<LocalFormSubmission>
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return
    if (existing.syncConflict) return
    await db.formSubmissions.put({ ...existing, syncStatus, ...extra, updatedAt: Date.now() })
  })
}


/** Explicit correction after a definite validation refusal; ambiguous transport failures stay queued. */
export async function correctRejectedForm(localId: string): Promise<LocalFormSubmission | undefined> {
  const userId = await getSessionUserId()
  return db.transaction('rw', db.formSubmissions, async () => {
    const row = await getFormSubmission(localId)
    if (!row || !isFormSubmissionOutboundOwnedByUser(row, userId) ||
        row.status !== 'submitted' || row.syncStatus !== 'failed' ||
        row.lastSubmitOutcome !== 'VALIDATION_ERROR') return undefined
    const next: LocalFormSubmission = {
      ...row, status: 'draft', syncStatus: 'pending', clientActionId: undefined,
      submittedAt: undefined, syncError: undefined, lastSubmitOutcome: undefined,
      // Correction alone must not send the rejected payload again. A deliberate save dirties it.
      locallyEditedAt: undefined, draftSyncedAt: undefined,
      draftSyncStatus: undefined, draftSyncError: undefined, updatedAt: Date.now()
    }
    await db.formSubmissions.put(next)
    return next
  })
}

/** The operator compared the server's answers and chose to save their local answers as a draft. */
export async function saveReviewedFormDraft(localId: string, remote: FormSubmissionDto,
  values: Record<string, unknown>, reporterUnitId: string, recordedAt?: number, saverName?: string): Promise<LocalFormSubmission> {
  const userId = await getSessionUserId()
  return db.transaction('rw', db.formSubmissions, db.attachments, async () => {
    const row = await getFormSubmission(localId)
    if (!row?.syncConflict || !isFormSubmissionOutboundOwnedByUser(row, userId) ||
        row.serverId !== String(remote.id) || String(remote.formDefinitionId) !== row.formDefinitionId ||
        remote.status !== 'DRAFT' || remote.updatedAt == null) {
      throw new Error('این نسخه برای اصلاح پیش‌نویس در دسترس نیست.')
    }
    await reconcileRemovedMedia(row, values)
    await reconcileRemovedMedia({ ...row, formData: remote.formData ?? {} }, values)
    const next: LocalFormSubmission = {
      ...row, formData: values, reporterUnitId, subjectUnitId: reporterUnitId,
      deviceTimeAt: recordedAt ?? row.deviceTimeAt, lastSavedByName: saverName ?? row.lastSavedByName,
      status: 'draft', serverStatus: 'DRAFT', syncStatus: 'pending', syncConflict: false,
      draftSyncStatus: 'pending', serverUpdatedAt: remote.updatedAt, locallyEditedAt: Date.now(),
      draftSyncedAt: undefined, syncError: undefined, draftSyncError: undefined,
      lastSubmitOutcome: undefined, clientActionId: undefined, submittedAt: undefined,
      draftClientActionId: uuidv4(), updatedAt: Date.now()
    }
    await db.formSubmissions.put(next)
    return next
  })
}
