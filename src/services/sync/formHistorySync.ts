import { fetchMyFormSubmissions, type FormSubmissionDto } from '@/services/api'
import { getSessionUserId } from '@/services/auth/sessionContext'
import { mapFormFieldSnapshots } from '@/services/forms/mapFormFields'
import { getAllFormDefinitions } from '@/services/storage/formDefinitions'
import {
  getFormSubmission,
  putFormSubmission,
  updateFormSubmission
} from '@/services/storage/formSubmissions'
import { db } from '@/services/storage/db'
import { formHistoryMustKeepLocal, isTerminalFormServerStatus } from '@/utils/formHistory'
import { toIdString } from '@/utils/ids'
import { coerceFormSubmissionServerStatus, type LocalFormSubmission } from '@/types'

/**
 * Pulls the signed-in operator's own filings and records submitted / approved / voided
 * rows for the history list.
 *
 * Best-effort and isolated from log sheets: a failure here must not fail an inbox merge.
 * A draft still being edited, and a final the server has not accepted, are left untouched.
 */
export async function pullOwnFormHistory(signal?: AbortSignal): Promise<void> {
  try {
    const [dtos, defs, userId] = await Promise.all([
      fetchMyFormSubmissions(signal),
      getAllFormDefinitions(),
      getSessionUserId()
    ])
    const titles = new Map(defs.map(d => [d.id, { title: d.title, code: d.code }]))
    await mergeOwnFormHistory(dtos, titles, userId)
  } catch (err) {
    console.warn('Form history pull failed', err)
  }
}

export async function mergeOwnFormHistory(
  dtos: FormSubmissionDto[],
  titles: Map<string, { title?: string; code?: string }>,
  userId: string | null
): Promise<void> {
  for (const dto of dtos) {
    const serverStatus = coerceFormSubmissionServerStatus(dto.status)
    if (!isTerminalFormServerStatus(serverStatus) || !serverStatus) continue
    const serverId = toIdString(dto.id)
    const localKey = dto.localId?.trim() || `server-form:${serverId}`
    const named = titles.get(toIdString(dto.formDefinitionId))
    const existing =
      (dto.localId ? await getFormSubmission(dto.localId) : undefined) ??
      (await db.formSubmissions.where('serverId').equals(serverId).first())

    if (existing && formHistoryMustKeepLocal(existing)) {
      if (!existing.serverId) {
        await updateFormSubmission(existing.localId, { serverId })
      }
      continue
    }

    const fields = mapFormFieldSnapshots(dto.fieldDefinitionsSnapshot)
    const now = Date.now()
    if (existing) {
      await putFormSubmission({
        ...existing,
        serverId,
        serverStatus,
        status: 'submitted',
        syncStatus: 'synced',
        formTitle: named?.title ?? existing.formTitle,
        formCode: named?.code ?? existing.formCode,
        formData: dto.formData ?? existing.formData,
        fieldDefinitionsSnapshot: fields.length > 0 ? fields : existing.fieldDefinitionsSnapshot,
        submittedAt: dto.submittedAt ?? existing.submittedAt,
        syncedAt: existing.syncedAt ?? dto.syncedAt ?? now,
        updatedAt: now
      })
      continue
    }

    const row: LocalFormSubmission = {
      id: localKey,
      localId: localKey,
      serverId,
      formDefinitionId: toIdString(dto.formDefinitionId),
      formTitle: named?.title,
      formCode: named?.code,
      reporterUnitId: toIdString(dto.reporterUnitId),
      subjectUnitId: toIdString(dto.subjectUnitId),
      status: 'submitted',
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
    await putFormSubmission(row)
  }
}
