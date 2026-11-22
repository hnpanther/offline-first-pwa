import { submitFormFinal, upsertFormDraft, type FormSubmitResult } from '@/services/api'
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
    if (ready === 'held') continue

    await setFormSubmissionSyncStatus(row.localId, 'syncing')
    const serverId = (await reloadServerId(row)) ?? row.serverId
    try {
      const result = await submitFormFinal(
        {
          submissionId: serverId ?? null,
          formDefinitionId: row.formDefinitionId,
          reporterUnitId: row.reporterUnitId,
          subjectUnitId: row.subjectUnitId,
          localId: row.localId,
          clientActionId: row.clientActionId,
          formData: row.formData,
          deviceTimeAt: row.deviceTimeAt ?? Date.now()
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
        outcome: 'DENIED',
        message: err instanceof Error ? err.message : 'خطا در ارسال فرم'
      })
    }
  }

  return { synced, failed }
}

type MediaGate = 'ready' | 'held' | 'transient'

/**
 * Makes sure the server still has a DRAFT, uploads this form's files, and refuses to
 * final-submit while any of them (signature included) is still unsent.
 *
 * Does not rewrite `formData`, delete attachment rows, or park a signature. A transport
 * failure stops the lane; any other miss leaves the final pending for the next pass.
 */
async function ensureDraftAndUploadMedia(
  row: LocalFormSubmission,
  signal?: AbortSignal
): Promise<MediaGate> {
  let unsent = await getUnsentFormAttachments(row.localId)
  if (unsent.length === 0) return 'ready'

  let serverId = row.serverId
  if (!serverId) {
    try {
      const drafted = await upsertFormDraft(
        {
          submissionId: null,
          formDefinitionId: row.formDefinitionId,
          reporterUnitId: row.reporterUnitId,
          subjectUnitId: row.subjectUnitId,
          localId: row.localId,
          clientActionId: row.draftClientActionId,
          formData: row.formData,
          deviceTimeAt: row.deviceTimeAt ?? Date.now()
        },
        signal
      )
      if (drafted.outcome !== 'OK' || drafted.submissionId == null) return 'held'
      serverId = String(drafted.submissionId)
      // Local status stays `submitted`. Only the server id is stamped, so the draft lane
      // (which ignores submitted rows) cannot clear the signature on the way through.
      await updateFormSubmission(row.localId, {
        serverId,
        serverStatus: row.serverStatus ?? 'DRAFT'
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) return 'transient'
      return 'held'
    }
  }

  await bindAttachmentsToServerForm(row.localId, serverId)
  const uploaded = await syncPendingFormAttachments(row.localId, signal)
  if (uploaded === 'aborted') return 'transient'

  unsent = await getUnsentFormAttachments(row.localId)
  return unsent.length === 0 ? 'ready' : 'held'
}

async function reloadServerId(row: LocalFormSubmission): Promise<string | undefined> {
  const fresh = await getFormSubmission(row.localId)
  return fresh?.serverId ?? row.serverId
}

async function settleFinal(row: LocalFormSubmission, result: FormSubmitResult): Promise<void> {
  const serverId =
    result.submissionId != null ? String(result.submissionId) : undefined
  await applyFormFinalSyncResult(row.localId, {
    serverId,
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
