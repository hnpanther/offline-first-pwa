import { fetchFormHistoryPage, type FormSubmissionDto } from '@/services/api'
import { serverNow } from '@/services/clock/serverClock'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { mapFormFieldSnapshots } from '@/services/forms/mapFormFields'
import { getAllFormDefinitions } from '@/services/storage/formDefinitions'
import { getSettings } from '@/services/storage'
import { resolveRetentionWindows } from './deviceRetention'
import { db } from '@/services/storage/db'
import { formHistoryMustKeepLocal } from '@/utils/formHistory'
import { toIdString } from '@/utils/ids'
import { coerceFormSubmissionServerStatus, type LocalFormSubmission } from '@/types'

type Titles = Map<string, { title?: string; code?: string }>
interface Checkpoint {
  after: number
  through?: number
  since: number
}

export async function pullOwnFormHistory(signal?: AbortSignal): Promise<void> {
  try {
    const userId = await getSessionUserId()
    if (!userId) return
    const key = `form-history:${userId}`
    const defs = await getAllFormDefinitions()
    const titles = new Map(defs.map(d => [d.id, { title: d.title, code: d.code }]))
    const { syncedMs } = resolveRetentionWindows((await getSettings()).deviceRetention)
    const cutoff = Math.max(0, serverNow() - syncedMs)
    let saved = (await db.syncMeta.get(key))?.value as Checkpoint | undefined
    // A pre-upgrade device may still have a draft the server finalized long ago.
    // Reconcile those once. Fresh devices only need open drafts and recent history.
    const hasOldDraft = !saved && await db.formSubmissions.where('status').equals('draft')
      .filter(r => !!r.serverId && (!r.createdByUserId || r.createdByUserId === userId)).first()
    while (!signal?.aborted) {
      const cursor = saved ?? { after: 0, since: hasOldDraft ? 0 : cutoff }
      const page = await fetchFormHistoryPage(cursor, signal)
      if (String(page.ownerId) !== userId || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean' ||
          !Number.isSafeInteger(page.next) || !Number.isSafeInteger(page.through) ||
          page.next < cursor.after || page.next > page.through ||
          (cursor.through != null && page.through !== cursor.through) ||
          (page.hasMore ? page.next <= cursor.after : page.next !== page.through)) {
        throw new Error('Invalid form history page')
      }
      const next: Checkpoint = page.hasMore
        ? { after: page.next, since: cursor.since, through: page.through }
        : { after: page.next, since: 0 }
      const applied = await db.transaction('rw', db.formSubmissions, db.syncMeta, async () => {
        const current = (await db.syncMeta.get(key))?.value as Checkpoint | undefined
        if (await getSessionUserId() !== userId || current?.after !== saved?.after ||
            current?.through !== saved?.through || current?.since !== saved?.since) return false
        await mergeOwnFormHistory(page.items, titles, userId, cutoff)
        await db.syncMeta.put({ key, value: next })
        return true
      })
      if (!applied || !page.hasMore) return
      saved = next
    }
  } catch (err) {
    console.warn('Form history pull failed', err)
  }
}

export async function mergeOwnFormHistory(
  dtos: FormSubmissionDto[], titles: Titles, userId: string | null, cutoff = 0
): Promise<void> {
  if (!userId || dtos.length === 0) return
  await db.transaction('rw', db.formSubmissions, async () => {
    const keys = dtos.map(dto => dto.localId?.trim() || `server-form:${dto.id}`)
    const ids = dtos.map(dto => toIdString(dto.id))
    const namedRows = await db.formSubmissions.where('localId').anyOf(keys).toArray()
    const serverRows = await db.formSubmissions.where('serverId').anyOf(ids).toArray()
    const byLocal = new Map(namedRows.map(r => [r.localId, r]))
    const byServer = new Map(serverRows.map(r => [r.serverId, r]))
    const writes: LocalFormSubmission[] = []
    for (const [i, dto] of dtos.entries()) {
      if (dto.reportedByUserId != null && toIdString(dto.reportedByUserId) !== userId) continue
      const existing = byLocal.get(keys[i]) ?? byServer.get(ids[i])
      if (existing?.createdByUserId && existing.createdByUserId !== userId) continue
      if (existing?.serverUpdatedAt != null && dto.updatedAt != null && dto.updatedAt < existing.serverUpdatedAt) continue
      if (existing && formHistoryMustKeepLocal(existing)) {
        if (!existing.serverId) writes.push({ ...existing, serverId: ids[i] })
        continue
      }
      const serverStatus = coerceFormSubmissionServerStatus(dto.status)
      if (!serverStatus) continue
      const anchor = dto.syncedAt ?? dto.submittedAt ?? dto.updatedAt
      if (!existing && serverStatus !== 'DRAFT' && anchor != null && anchor < cutoff) continue
      writes.push(mergeRow(dto, existing, serverStatus, titles, userId))
    }
    if (writes.length) await db.formSubmissions.bulkPut(writes)
  })
}

function mergeRow(
  dto: FormSubmissionDto, existing: LocalFormSubmission | undefined,
  serverStatus: NonNullable<LocalFormSubmission['serverStatus']>, titles: Titles, userId: string
): LocalFormSubmission {
  const isDraft = serverStatus === 'DRAFT'
  const serverId = toIdString(dto.id)
  const localKey = dto.localId?.trim() || `server-form:${serverId}`
  const named = titles.get(toIdString(dto.formDefinitionId))
  const fields = mapFormFieldSnapshots(dto.fieldDefinitionsSnapshot)
  const now = Date.now()
  if (existing) {
    return {
      ...existing,
      serverId,
      serverStatus,
      status: isDraft ? 'draft' : 'submitted',
      syncStatus: 'synced',
      serverUpdatedAt: dto.updatedAt,
      lastSavedByName: dto.lastSavedByName === undefined ? existing.lastSavedByName : dto.lastSavedByName ?? undefined,
      reporterUnitId: toIdString(dto.reporterUnitId),
      subjectUnitId: toIdString(dto.subjectUnitId),
      ...(isDraft ? {
        clientActionId: undefined, locallyEditedAt: undefined, draftSyncedAt: undefined,
        draftSyncStatus: 'synced' as const, draftSyncError: undefined,
        syncError: undefined, lastSubmitOutcome: undefined
      } : {}),
      formTitle: named?.title ?? existing.formTitle,
      formCode: named?.code ?? existing.formCode,
      formData: dto.formData ?? existing.formData,
      fieldDefinitionsSnapshot: fields.length > 0 ? fields : existing.fieldDefinitionsSnapshot,
      submittedAt: isDraft ? undefined : dto.submittedAt ?? existing.submittedAt,
      syncedAt: existing.syncedAt ?? dto.syncedAt ?? now,
      updatedAt: now
    }
  }

  return {
    id: localKey,
    localId: localKey,
    serverId,
    serverUpdatedAt: dto.updatedAt,
    formDefinitionId: toIdString(dto.formDefinitionId),
    lastSavedByName: dto.lastSavedByName ?? undefined,
    formTitle: named?.title,
    formCode: named?.code,
    reporterUnitId: toIdString(dto.reporterUnitId),
    subjectUnitId: toIdString(dto.subjectUnitId),
    status: isDraft ? 'draft' : 'submitted',
    serverStatus,
    formData: dto.formData ?? {},
    fieldDefinitionsSnapshot: fields,
    createdByUserId:
      dto.reportedByUserId != null ? toIdString(dto.reportedByUserId) : userId ?? undefined,
    syncStatus: 'synced',
    syncError: undefined,
    createdAt: dto.createdAt ?? now,
    updatedAt: dto.updatedAt ?? now,
    submittedAt: dto.submittedAt,
    syncedAt: dto.syncedAt ?? now,
    deviceTimeAt: dto.deviceTimeAt
  }
}
