import { submitFormFinal, type FormSubmitResult } from '@/services/api'
import { ApiError } from '@/services/api/client'
import { getSessionUserId } from '@/services/auth/sessionContext'
import {
  applyFormFinalSyncResult,
  getPendingFormFinals,
  setFormSubmissionSyncStatus
} from '@/services/storage/formSubmissions'
import { bindAttachmentsToServerForm } from '@/services/storage/attachments'
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

    await setFormSubmissionSyncStatus(row.localId, 'syncing')
    try {
      const result = await submitFormFinal(
        {
          submissionId: row.serverId ?? null,
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
