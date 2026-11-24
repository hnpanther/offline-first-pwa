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
  row: Pick<LocalFormSubmission, 'status' | 'createdByUserId' | 'locallyEditedAt' | 'draftSyncedAt'>,
  userId: string | null
): boolean {
  if (!isFormSubmissionOutboundOwnedByUser(row, userId)) return false
  if (row.status !== 'draft') return false
  if (row.locallyEditedAt == null) return false
  // Already mirrored at this exact edit stamp — wait for a newer save.
  if (row.draftSyncedAt != null && row.draftSyncedAt >= row.locallyEditedAt) return false
  return true
}

/** Final-submit lane — finished work waiting for a server outcome. */
export function isFormFinalOwnedByUser(
  row: Pick<LocalFormSubmission, 'status' | 'syncStatus' | 'createdByUserId' | 'clientActionId'>,
  userId: string | null
): boolean {
  if (!isFormSubmissionOutboundOwnedByUser(row, userId)) return false
  if (row.status !== 'submitted') return false
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
    deviceTimeAt: now,
    ...(createdByUserId ? { createdByUserId } : {})
  }
  await db.formSubmissions.add(row)
  return row
}

export async function saveLocalFormDraft(
  localId: string,
  formData: Record<string, unknown>,
  reporterUnitId?: string
): Promise<LocalFormSubmission | undefined> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing || existing.status !== 'draft') return existing
    const now = Math.max(Date.now(), (existing.locallyEditedAt ?? 0) + 1, (existing.draftSyncedAt ?? 0) + 1)
    const next: LocalFormSubmission = {
      ...existing,
      formData,
      reporterUnitId: reporterUnitId ?? existing.reporterUnitId,
      subjectUnitId: reporterUnitId ?? existing.reporterUnitId,
      locallyEditedAt: now,
      draftSyncStatus: 'pending',
      draftSyncError: undefined,
      updatedAt: now,
      deviceTimeAt: now
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
  formData: Record<string, unknown>
): Promise<LocalFormSubmission | undefined> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing || existing.status !== 'draft') return existing
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
      deviceTimeAt: now,
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
    editedAt?: number
  }
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing || existing.status !== 'draft') return

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
        draftSyncStatus: 'synced',
        draftSyncedAt: stillSameEdit ? existing.locallyEditedAt : existing.draftSyncedAt,
        draftSyncError: undefined,
        updatedAt: Date.now()
      })
      return
    }

    await db.formSubmissions.put({
      ...existing,
      draftSyncStatus: 'failed',
      draftSyncError: result.message ?? result.outcome,
      updatedAt: Date.now()
    })
  })
}

export async function applyFormFinalSyncResult(
  localId: string,
  result: {
    serverId?: string
    outcome: string
    status?: string
    message?: string | null
  }
): Promise<void> {
  return db.transaction('rw', db.formSubmissions, async () => {
    const existing = await getFormSubmission(localId)
    if (!existing) return

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
    await db.formSubmissions.put({ ...existing, syncStatus, ...extra, updatedAt: Date.now() })
  })
}
