import { upsertFormDraft, type FormSubmitResult } from '@/services/api'
import { formSchemaEvidence } from '@/services/forms/mapFormFields'
import { ApiError } from '@/services/api/client'
import { getSessionUserId } from '@/services/auth/sessionContext'
import {
  applyFormDraftSyncResult,
  getPendingFormDrafts
} from '@/services/storage/formSubmissions'
import { bindAttachmentsToServerForm } from '@/services/storage/attachments'
import type { LocalFormSubmission } from '@/types'

export interface FormDraftSyncResult {
  pushed: number
  refused: number
}

/**
 * Draft upsert lane for ad-hoc forms — the progress-queue twin.
 *
 * Never writes `syncStatus` / `syncError` / `status`. A refused draft costs nothing: the values
 * stay on the device and still deliver on final submit. Not counted in the pending badge.
 */
export async function pushPendingFormDrafts(signal?: AbortSignal): Promise<FormDraftSyncResult> {
  const userId = await getSessionUserId()
  const pending = await getPendingFormDrafts(userId)
  let pushed = 0
  let refused = 0

  for (const row of pending) {
    if (signal?.aborted) break
    const editedAt = row.locallyEditedAt
    try {
      const result = await upsertFormDraft(
        {
          submissionId: row.serverId ?? null,
          formDefinitionId: row.formDefinitionId,
          ...formSchemaEvidence(row),
          reporterUnitId: row.reporterUnitId,
          subjectUnitId: row.subjectUnitId,
          localId: row.localId,
          clientActionId: row.draftClientActionId,
          formData: row.formData,
          deviceTimeAt: row.deviceTimeAt ?? Date.now()
        },
        signal
      )
      await settleDraft(row, result, editedAt)
      if (result.outcome === 'OK') pushed++
      else refused++
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) break
      refused++
      await applyFormDraftSyncResult(row.localId, {
        outcome: 'DENIED',
        message: err instanceof Error ? err.message : 'خطا در همگام‌سازی پیش‌نویس'
      })
    }
  }

  return { pushed, refused }
}

async function settleDraft(
  row: LocalFormSubmission,
  result: FormSubmitResult,
  editedAt: number | undefined
): Promise<void> {
  const serverId =
    result.submissionId != null ? String(result.submissionId) : undefined
  await applyFormDraftSyncResult(row.localId, {
    serverId,
    outcome: result.outcome,
    status: result.status ?? undefined,
    message: result.message,
    editedAt
  })
  // Once the server has a draft id, form-owned media finally has somewhere to go.
  if (result.outcome === 'OK' && serverId) {
    await bindAttachmentsToServerForm(row.localId, serverId)
  }
}
