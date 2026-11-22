import type { LocalAttachment } from '@/types'

/**
 * Owner keys for a signature PNG in the attachment table.
 *
 * Same XOR rule as photo/audio/video (`AttachmentFieldInput`): exactly one of
 * log-sheet local id or form-submission local id. Forms must never alias their
 * `localId` into `logSheetLocalId` — the upload queue and server both key on
 * `formSubmissionId`.
 */
export function signatureAttachmentOwner(ctx: {
  logSheetLocalId?: string
  logSheetServerId?: string
  formSubmissionLocalId?: string
  formSubmissionId?: string
  assetId?: string
}): Pick<
  LocalAttachment,
  'logSheetLocalId' | 'logSheetServerId' | 'formSubmissionLocalId' | 'formSubmissionId' | 'assetId'
> {
  if (ctx.formSubmissionLocalId) {
    return {
      formSubmissionLocalId: ctx.formSubmissionLocalId,
      ...(ctx.formSubmissionId ? { formSubmissionId: ctx.formSubmissionId } : {}),
      assetId: undefined
    }
  }
  return {
    logSheetLocalId: ctx.logSheetLocalId,
    ...(ctx.logSheetServerId ? { logSheetServerId: ctx.logSheetServerId } : {}),
    assetId: ctx.assetId
  }
}

/** True when the context names exactly one attachment owner lane. */
export function hasSignatureAttachmentOwner(ctx: {
  logSheetLocalId?: string
  formSubmissionLocalId?: string
}): boolean {
  const form = !!ctx.formSubmissionLocalId
  const sheet = !!ctx.logSheetLocalId
  return form !== sheet && (form || sheet)
}
