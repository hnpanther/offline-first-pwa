import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import { saveLogSheet } from '@/services/storage'
import {
  getAttachment,
  getPendingAttachments,
  markAttachmentPendingDelete,
  saveAttachment
} from '@/services/storage/attachments'
import {
  getOwnPendingAttachments,
  syncPendingAttachments
} from '@/services/sync/attachmentSync'
import { reviveOwnedSubmittedQueueOnLogin } from '@/services/auth/sessionContext'
import {
  isAttachmentUploadableByUser,
  shouldReviveParkedAttachment
} from '@/utils/attachmentOwnership'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import type { LocalAttachment, LogSheet } from '@/types'

const uploadAttachment = vi.fn()
const deleteRemoteAttachment = vi.fn()
vi.mock('@/services/api', () => ({
  uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  deleteRemoteAttachment: (...args: unknown[]) => deleteRemoteAttachment(...args),
  fetchBootstrap: () => Promise.reject(new Error('not used'))
}))

/**
 * Captured media on a shared tablet.
 *
 * The defect, reported from the plant and reproduced here: operator 1 of unit 1 picks up a
 * round, goes offline, records readings and takes photographs, video and a voice note — then
 * signs out, still offline, and never comes back online. Operator 2 of unit 2, whose work has
 * nothing to do with unit 1, picks the tablet up, connects and signs in.
 *
 * Signing out only removes the session key; the rows stay on the device on purpose, because
 * that is the only copy of the work. But the attachment queue had no notion of *whose* rows
 * they were — unlike the log-sheet queue, which has filtered by owner all along. So operator
 * 2's session pushed operator 1's files, the server refused each with **403** ("دسترسی به این
 * لاگ شیت مجاز نیست"), and a 403 was classified as permanent.
 *
 * The result was the worst available: operator 1's evidence was **parked**, so when they signed
 * back in the queue no longer offered it at all. Photographs of equipment that cannot be
 * re-photographed were stranded behind a per-file retry button nobody would think to press.
 */

const NOW = 1_700_000_000_000
const OP1 = '11'
const OP2 = '22'

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    localId: 'sheet-op1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند واحد ۱',
    scopeSummary: '',
    assigneeUserId: OP1,
    localOwnerUserId: OP1,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    entries: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function attachment(overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id: 'photo-op1',
    logSheetLocalId: 'sheet-op1',
    logSheetServerId: '55',
    assetId: '7',
    fieldKey: 'pump_photo',
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 1234,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'pending',
    createdAt: NOW,
    ...overrides
  }
}

async function signIn(userId: string): Promise<void> {
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(userId) })
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.attachments.clear()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  uploadAttachment.mockReset()
  uploadAttachment.mockResolvedValue({ id: 'photo-op1' })
  deleteRemoteAttachment.mockReset()
  deleteRemoteAttachment.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------

describe('the reported scenario, end to end', () => {
  it('does not send one operator’s captured media under another operator’s session', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP2)

    const result = await syncPendingAttachments()

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(result.uploaded).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('leaves the file exactly as it was, queued and unparked', async () => {
    // The whole point: operator 2 signing in must cost operator 1 nothing at all.
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP2)

    await syncPendingAttachments()

    const row = await getAttachment('photo-op1')
    expect(row?.syncStatus).toBe('pending')
    expect(row?.permanentFailure).toBeUndefined()
    expect(row?.syncError).toBeUndefined()
  })

  it('delivers everything the moment the owner signs back in', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(attachment())

    await signIn(OP2)
    await syncPendingAttachments()
    await signIn(OP1)
    const result = await syncPendingAttachments()

    expect(result.uploaded).toBe(1)
    expect((await getAttachment('photo-op1'))?.syncStatus).toBe('synced')
  })

  it('covers video and voice notes the same way — the rule is about ownership, not file type', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(attachment({ id: 'clip', kind: 'VIDEO', mimeType: 'video/webm' }))
    await saveAttachment(attachment({ id: 'note', kind: 'AUDIO', mimeType: 'audio/webm' }))
    await signIn(OP2)

    await syncPendingAttachments()

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect((await getAttachment('clip'))?.syncStatus).toBe('pending')
    expect((await getAttachment('note'))?.syncStatus).toBe('pending')
  })

  it('still sends the signed-in operator’s own files on the same pass', async () => {
    // The filter has to be a scalpel: operator 2 came to work, and their own round must sync.
    await saveLogSheet(sheet())
    await saveLogSheet(sheet({ localId: 'sheet-op2', serverId: '66', assigneeUserId: OP2, localOwnerUserId: OP2 }))
    await saveAttachment(attachment())
    await saveAttachment(attachment({ id: 'photo-op2', logSheetLocalId: 'sheet-op2', logSheetServerId: '66' }))
    await signIn(OP2)

    await syncPendingAttachments()

    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'photo-op2' }))
  })

  it('does not tell the server to delete another operator’s file either', async () => {
    // A deletion goes out under the same token as an upload and earns the same refusal.
    await saveLogSheet(sheet())
    await saveAttachment(attachment({ syncStatus: 'synced' }))
    await markAttachmentPendingDelete('photo-op1')
    await signIn(OP2)

    await syncPendingAttachments()

    expect(deleteRemoteAttachment).not.toHaveBeenCalled()
    expect(await getAttachment('photo-op1')).toBeDefined()
  })

  it('does not count another operator’s files in the pending badge', async () => {
    // A count that can never reach zero reads as a broken sync, and invites someone to
    // "fix" it by clearing the device — which is how the evidence would actually be lost.
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP2)

    expect(await getOwnPendingAttachments()).toEqual([])
    // The row is still there, still waiting for its owner.
    expect((await getPendingAttachments()).map(r => r.id)).toEqual(['photo-op1'])
  })
})

describe('a 403 is about who is signed in, not about the file', () => {
  it('keeps the file queued rather than parking it', async () => {
    // Defence in depth: the owner filter should mean this never happens, but if it does the
    // cost must be a retry, not the loss of the only copy of somebody's work.
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP1)
    uploadAttachment.mockRejectedValue(new ApiError(403, 'دسترسی به این لاگ شیت مجاز نیست.'))

    await syncPendingAttachments()

    const row = await getAttachment('photo-op1')
    expect(row?.syncStatus).toBe('failed')
    expect(row?.permanentFailure).toBeUndefined()
    expect((await getPendingAttachments()).map(r => r.id)).toEqual(['photo-op1'])
  })

  it('records the status, because the stored reason is prose and cannot be classified', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP1)
    uploadAttachment.mockRejectedValue(new ApiError(403, 'دسترسی به این لاگ شیت مجاز نیست.'))

    await syncPendingAttachments()

    expect((await getAttachment('photo-op1'))?.failedStatus).toBe(403)
  })

  it('still parks a refusal that really is about the file', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(attachment())
    await signIn(OP1)
    uploadAttachment.mockRejectedValue(new ApiError(400, 'Unsupported attachment file type.'))

    await syncPendingAttachments()

    const row = await getAttachment('photo-op1')
    expect(row?.permanentFailure).toBe(true)
    expect(row?.failedStatus).toBe(400)
  })
})

describe('healing tablets that already stranded somebody’s work', () => {
  it('gives a file parked under the wrong session back to its owner at sign-in', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(
      attachment({
        syncStatus: 'failed',
        permanentFailure: true,
        failedStatus: 403,
        syncError: 'دسترسی به این لاگ شیت مجاز نیست.'
      })
    )
    await signIn(OP1)

    await reviveOwnedSubmittedQueueOnLogin(OP1)

    const row = await getAttachment('photo-op1')
    expect(row?.permanentFailure).toBeUndefined()
    expect(row?.syncStatus).toBe('pending')
  })

  it('revives a row parked before the status was ever recorded', async () => {
    // Every tablet in the field has these, and they are exactly the ones the defect stranded.
    await saveLogSheet(sheet())
    await saveAttachment(
      attachment({ syncStatus: 'failed', permanentFailure: true, syncError: 'رد شده توسط سرور' })
    )
    await signIn(OP1)

    await reviveOwnedSubmittedQueueOnLogin(OP1)

    expect((await getAttachment('photo-op1'))?.syncStatus).toBe('pending')
  })

  it('leaves a genuinely rejected file parked', async () => {
    // Reviving a file the server will refuse again just moves the waste to every sign-in.
    await saveLogSheet(sheet())
    await saveAttachment(
      attachment({ syncStatus: 'failed', permanentFailure: true, failedStatus: 400 })
    )
    await signIn(OP1)

    await reviveOwnedSubmittedQueueOnLogin(OP1)

    expect((await getAttachment('photo-op1'))?.permanentFailure).toBe(true)
  })

  it('does not revive another operator’s files — signing in is not a takeover', async () => {
    await saveLogSheet(sheet())
    await saveAttachment(
      attachment({ syncStatus: 'failed', permanentFailure: true, failedStatus: 403 })
    )
    await signIn(OP2)

    await reviveOwnedSubmittedQueueOnLogin(OP2)

    expect((await getAttachment('photo-op1'))?.permanentFailure).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('who may send a file', () => {
  it('accepts the operator who owns the work', () => {
    expect(isAttachmentUploadableByUser(sheet(), OP1)).toBe(true)
  })

  /**
   * The row's own owner is checked first and can veto the sheet.
   *
   * <p>After a reassignment the local sheet row is reused, so `localOwnerUserId` names the *new*
   * operator while the media on it is still the previous one's. Judging by the sheet alone would
   * put a colleague's photographs in this operator's outbound queue, under their token — the
   * exact trespass this predicate exists to stop, reached from the other direction.
   */
  it('refuses a file a colleague captured, whatever the sheet now says', () => {
    expect(
      isAttachmentUploadableByUser(sheet(), OP1, { createdByUserId: OP2 })
    ).toBe(false)
  })

  it('accepts a file this operator captured on their own sheet', () => {
    expect(
      isAttachmentUploadableByUser(sheet(), OP1, { createdByUserId: OP1 })
    ).toBe(true)
  })

  /** A row captured before the field existed falls back rather than being stranded. */
  it('accepts a row with no owner', () => {
    expect(isAttachmentUploadableByUser(sheet(), OP1, {})).toBe(true)
  })

  /**
   * Owning the file is necessary, not sufficient. A sheet the operator has lost still refuses
   * it, because the server would too.
   */
  it('still refuses their own file on a sheet that is no longer theirs', () => {
    expect(
      isAttachmentUploadableByUser(sheet({ localOwnerUserId: OP2, assigneeUserId: OP2 }), OP1,
        { createdByUserId: OP1 })
    ).toBe(false)
  })

  it('accepts a sheet assigned to them even before anything was saved locally', () => {
    expect(isAttachmentUploadableByUser(sheet({ localOwnerUserId: undefined }), OP1)).toBe(true)
  })

  it('refuses anybody else', () => {
    expect(isAttachmentUploadableByUser(sheet(), OP2)).toBe(false)
  })

  it('refuses when there is no sheet to prove ownership by', () => {
    // Uploading on a guess is what caused the defect. Declining costs a delay; the file stays.
    expect(isAttachmentUploadableByUser(undefined, OP1)).toBe(false)
  })

  it('refuses a sheet nobody owns', () => {
    expect(
      isAttachmentUploadableByUser(
        sheet({ localOwnerUserId: undefined, assigneeUserId: undefined }),
        OP1
      )
    ).toBe(false)
  })

  it('refuses when nobody is signed in', () => {
    expect(isAttachmentUploadableByUser(sheet(), null)).toBe(false)
  })

  it('judges a synced sheet by ownership too', () => {
    // The case that leaked past the shared-tablet isolation: it blocks another user's *unsynced*
    // sheets and deliberately leaves synced ones alone, but a synced sheet's photos can still be
    // queued — and those are exactly what went out under the wrong token.
    const delivered = sheet({ status: 'submitted', syncStatus: 'synced', serverStatus: 'SUBMITTED' })
    expect(isAttachmentUploadableByUser(delivered, OP1)).toBe(true)
    expect(isAttachmentUploadableByUser(delivered, OP2)).toBe(false)
  })

  it('refuses a sheet the operator has lost, however much they own it locally', () => {
    // Otherwise the queue retries a 403 every thirty seconds for the rest of the shift.
    const revoked = sheet({ syncStatus: 'failed', syncError: SYNC_OUTCOME_MESSAGES.REVOKED })
    expect(isAttachmentUploadableByUser(revoked, OP1)).toBe(false)
  })

  it('refuses a sheet somebody else already completed', () => {
    const superseded = sheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'SUBMITTED'
    })
    expect(isAttachmentUploadableByUser(superseded, OP1)).toBe(false)
  })
})

describe('which parked files deserve another chance', () => {
  it('revives a 403 — it described the session, not the file', () => {
    expect(shouldReviveParkedAttachment(403)).toBe(true)
  })

  it('revives a row parked before the status was recorded', () => {
    expect(shouldReviveParkedAttachment(undefined)).toBe(true)
  })

  it('leaves a rejected payload alone', () => {
    expect(shouldReviveParkedAttachment(400)).toBe(false)
    expect(shouldReviveParkedAttachment(404)).toBe(false)
    expect(shouldReviveParkedAttachment(422)).toBe(false)
  })
})
