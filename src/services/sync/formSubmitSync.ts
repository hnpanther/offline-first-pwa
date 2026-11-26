import { submitFormFinal, upsertFormDraft, type FormSubmitResult } from '@/services/api'
import { formSchemaEvidence } from '@/services/forms/mapFormFields'
import { ApiError } from '@/services/api/client'
import { getSessionUserId } from '@/services/auth/sessionContext'
import {
  applyFormFinalSyncResult,
  getFormSubmission,
  getPendingFormFinals,
  setFormSubmissionSyncStatus,
  updateFormSubmission
} from '@/services/storage/formSubmissions'
import {
  bindAttachmentsToServerForm,
  getUnsentFormAttachments
} from '@/services/storage/attachments'
import { syncPendingFormAttachments } from '@/services/sync/attachmentSync'
import type { LocalFormSubmission } from '@/types'

export interface FormSubmitSyncResult {
  synced: number
  failed: number
  transientError?: string
}

/**
 * Final-submit lane for ad-hoc forms — the batch-submit twin.
 *
 * Counted in the pending badge. Idempotent via `clientActionId` (`DUPLICATE` = accepted).
 * Never discards a refused payload — VALIDATION_ERROR / DENIED stay on the device as failed.
 *
 * Media, including a signature, is uploaded while the server row is still a DRAFT. The server
 * answers 409 `Submitted form cannot be edited` if the file arrives after final submit and the
 * stored answers do not already name it. A form that still has unsent media is left pending;
 * the signature row and the ids in `formData` stay where the operator put them.
 */
export async function pushPendingFormFinals(signal?: AbortSignal): Promise<FormSubmitSyncResult> {
  const userId = await getSessionUserId()
  const pending = await getPendingFormFinals(userId)
  let synced = 0
  let failed = 0

  for (const row of pending) {
    if (signal?.aborted) break
    if (!row.clientActionId) {
      // Should have been stamped at local finalise; mint once and persist so retries share it.
      await setFormSubmissionSyncStatus(row.localId, 'pending', {
        clientActionId: cryptoRandom()
      })
      continue
    }

    const ready = await ensureDraftAndUploadMedia(row, signal)
    if (ready === 'transient') {
      return {
        synced,
        failed,
        transientError: 'ارتباط با سرور برقرار نشد'
      }
    }
    if (ready === 'refused') { failed++; continue }
    if (ready === 'held') continue

    await setFormSubmissionSyncStatus(row.localId, 'syncing')
    // Upload may have re-minted a file and rewritten the stored answers.
    const fresh = await getFormSubmission(row.localId)
    if (!fresh || fresh.syncConflict || fresh.status !== 'submitted' || !fresh.clientActionId) continue
    try {
      const result = await submitFormFinal(
        {
          submissionId: fresh.serverId ?? null,
          formDefinitionId: fresh.formDefinitionId,
          ...formSchemaEvidence(fresh),
          expectedUpdatedAt: fresh.serverUpdatedAt ?? 0,
          requireUploadedMedia: true,
          reporterUnitId: fresh.reporterUnitId,
          subjectUnitId: fresh.subjectUnitId,
          localId: fresh.localId,
          clientActionId: fresh.clientActionId,
          formData: fresh.formData,
          deviceTimeAt: fresh.deviceTimeAt ?? Date.now()
        },
        signal
      )
      await settleFinal(row, result)
      if (result.outcome === 'OK' || result.outcome === 'DUPLICATE') synced++
      else failed++
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        await setFormSubmissionSyncStatus(row.localId, 'pending')
        return {
          synced,
          failed,
          transientError: err.message || 'ارتباط با سرور برقرار نشد'
        }
      }
      failed++
      await applyFormFinalSyncResult(row.localId, {
        outcome: isRejectedPayload(err) ? 'VALIDATION_ERROR' : 'DENIED',
        message: err instanceof Error ? err.message : 'خطا در ارسال فرم'
      })
    }
  }

  return { synced, failed }
}

function isRejectedPayload(error: unknown): error is ApiError {
  return error instanceof ApiError && [400, 413, 422].includes(error.status)
}

type MediaGate = 'ready' | 'held' | 'transient' | 'refused'

/**
 * Makes sure the server still has a DRAFT, uploads this form's files, and refuses to
 * final-submit while any of them (signature included) is still unsent.
 *
 * Transport failures are retryable. A definitive payload refusal preserves the answers and
 * files and lets the operator correct the filing.
 */
async function ensureDraftAndUploadMedia(
  row: LocalFormSubmission,
  signal?: AbortSignal
): Promise<MediaGate> {
  let unsent = await getUnsentFormAttachments(row.localId)
  if (unsent.length === 0) {
    if (row.serverId && await syncPendingFormAttachments(row.localId, signal) === 'aborted') return 'transient'
    return 'ready'
  }

  let serverId = row.serverId
  if (!serverId) {
    try {
      const drafted = await upsertFormDraft(
        {
          submissionId: null,
          formDefinitionId: row.formDefinitionId,
          ...formSchemaEvidence(row),
          expectedUpdatedAt: row.serverUpdatedAt ?? 0,
          reporterUnitId: row.reporterUnitId,
          subjectUnitId: row.subjectUnitId,
          localId: row.localId,
          clientActionId: row.draftClientActionId,
          formData: row.formData,
          deviceTimeAt: row.deviceTimeAt ?? Date.now()
        },
        signal
      )
      if (drafted.outcome !== 'OK') {
        await settleFinal(row, drafted)
        return 'refused'
      }
      if (drafted.submissionId == null) return 'held'
      serverId = String(drafted.submissionId)
      // Local status stays `submitted`. Only the server id is stamped, so the draft lane
      // (which ignores submitted rows) cannot clear the signature on the way through.
      await updateFormSubmission(row.localId, {
        serverId,
        serverUpdatedAt: drafted.updatedAt,
        serverStatus: row.serverStatus ?? 'DRAFT'
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) return 'transient'
      if (isRejectedPayload(err)) {
        await applyFormFinalSyncResult(row.localId, { outcome: 'VALIDATION_ERROR', message: err.message })
        return 'refused'
      }
      return 'held'
    }
  }

  await bindAttachmentsToServerForm(row.localId, serverId)
  const uploaded = await syncPendingFormAttachments(row.localId, signal)
  if (uploaded === 'aborted') return 'transient'

  unsent = await getUnsentFormAttachments(row.localId)
  const parked = unsent.find(file => file.permanentFailure)
  if (parked) {
    await applyFormFinalSyncResult(row.localId, {
      outcome: 'VALIDATION_ERROR',
      message: `پیوست فیلد «${parked.fieldKey}» ارسال نشد. ${parked.syncError ?? 'فایل را بررسی یا جایگزین کنید.'}`
    })
    return 'refused'
  }
  return unsent.length === 0 ? 'ready' : 'held'
}

async function settleFinal(row: LocalFormSubmission, result: FormSubmitResult): Promise<void> {
  const serverId =
    result.submissionId != null ? String(result.submissionId) : undefined
  await applyFormFinalSyncResult(row.localId, {
    actionId: row.clientActionId,
    serverId,
    updatedAt: result.updatedAt,
    outcome: result.outcome,
    status: result.status ?? undefined,
    message: result.message
  })
  if ((result.outcome === 'OK' || result.outcome === 'DUPLICATE') && serverId) {
    await bindAttachmentsToServerForm(row.localId, serverId)
  }
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `form-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
