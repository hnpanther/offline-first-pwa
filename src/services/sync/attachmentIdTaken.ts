/**
 * An upload whose id the server already holds for somebody else's file (backend B-10, issue P-06).
 *
 * The id is minted on this device and written into the round's answers before the bytes go up —
 * and the answers reach the server first, where anyone who may read the round can read them. A
 * colleague could therefore upload their own file under the id first. The server used to answer
 * the owner's upload `403`, which the queue retries for ever (a 403 on a shared tablet usually
 * means the wrong person is signed in), so the photograph never landed.
 *
 * It now answers `409 ATTACHMENT_ID_TAKEN`, and the device's answer is to give the file a fresh id
 * and point the round's answer at it — once. A second collision is parked with its reason, and so
 * is a first one on a round that can no longer carry a new reference to the server (delivered, or
 * refused and kept): re-minting there would upload a file nothing on the server names.
 */

import { v4 as uuidv4 } from 'uuid'
import { ApiError } from '@/services/api/client'
import { db } from '@/services/storage/db'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { isArchivedSessionSnapshot } from '@/utils/logSheetStatus'
import { toIdString } from '@/utils/ids'
import type { LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'

/** The stable code the server sends; never reworded. */
export const ATTACHMENT_ID_TAKEN = 'ATTACHMENT_ID_TAKEN'

/** Shown on a parked row — the bytes stay on this device, with the manual retry. */
export const ATTACHMENT_ID_TAKEN_MESSAGE =
  'شناسه‌ی این فایل روی سرور پیش‌تر برای فایل دیگری ثبت شده است و این راند دیگر نمی‌تواند شناسه‌ی تازه را به سرور برساند. فایل روی همین دستگاه نگه داشته شده است.'

export function isAttachmentIdTaken(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === ATTACHMENT_ID_TAKEN
}

/**
 * Whether this round can still carry a changed reference to the server: a draft (its next progress
 * push, or late-progress push, carries the answer), or a completion not yet sent (its submit
 * carries it). A delivered or refused round cannot — the server's copy of its answers is final.
 */
export function canStillCarryNewReference(
  sheet: Pick<LogSheet, 'localId' | 'status' | 'syncStatus'> | undefined
): boolean {
  if (!sheet || isArchivedSessionSnapshot(sheet)) return false
  if (sheet.status === 'draft') return true
  return sheet.syncStatus !== 'synced' && sheet.syncStatus !== 'failed'
}

/** The form value with one attachment id replaced, or the value unchanged when it does not name it. */
function withIdReplaced(value: unknown, oldId: string, newId: string): unknown {
  const ids = attachmentIdsOf(value)
  if (!ids.includes(oldId)) return value
  return buildAttachmentRef(ids.map(id => (id === oldId ? newId : id)))
}

function rewriteEntryReference(
  entries: LogSheetEntryData[],
  attachment: LocalAttachment,
  newId: string,
  now: number
): LogSheetEntryData[] {
  const assetId = toIdString(attachment.assetId)
  return entries.map(entry => {
    if (toIdString(entry.assetId) !== assetId) return entry
    const current = entry.formData?.[attachment.fieldKey]
    const next = withIdReplaced(current, attachment.id, newId)
    if (next === current) return entry
    // Marked edited, so the next progress push carries the new reference and later merges keep it.
    return { ...entry, formData: { ...entry.formData, [attachment.fieldKey]: next }, locallyEditedAt: now }
  })
}

/** The round's rows with this file's reference pointed at `newId`, marked as this device's edit. */
function sheetWithReferenceRewritten(
  sheet: LogSheet,
  attachment: LocalAttachment,
  newId: string,
  now: number
): Partial<LogSheet> {
  if (attachment.assetId != null) {
    return { entries: rewriteEntryReference(sheet.entries ?? [], attachment, newId, now) }
  }
  const current = sheet.sheetFormData?.[attachment.fieldKey]
  const next = withIdReplaced(current, attachment.id, newId)
  if (next === current) return {}
  return {
    sheetFormData: { ...sheet.sheetFormData, [attachment.fieldKey]: next },
    sheetFormLocallyEditedAt: now
  }
}

/**
 * Gives a file whose id was taken a fresh one, and points its round's answer at it — in one
 * transaction, so a crash can never leave the answer naming an id no row holds.
 *
 * @returns the re-minted row, ready to upload; or `null` when the rule is to park instead — the
 *          file was re-minted once already, or its round can no longer carry a new reference.
 */
export async function remintTakenAttachment(
  attachment: LocalAttachment,
  now = Date.now()
): Promise<LocalAttachment | null> {
  if (attachment.idRemintedFrom != null) return null

  // Form-owned media: rewrite the form submission's formData the same way a sheet's entry is.
  if (attachment.formSubmissionLocalId) {
    return db.transaction('rw', db.attachments, db.formSubmissions, async () => {
      const form = await db.formSubmissions
        .where('localId')
        .equals(attachment.formSubmissionLocalId!)
        .first()
      if (!form || form.status !== 'draft') return null

      const newId = uuidv4()
      const reminted: LocalAttachment = {
        ...attachment,
        id: newId,
        idRemintedFrom: attachment.id,
        syncStatus: 'pending',
        syncError: undefined,
        permanentFailure: undefined,
        failedStatus: undefined
      }
      const formData = rewriteFormAttachmentRef(form.formData, attachment.fieldKey, attachment.id, newId)
      await db.formSubmissions.update(form.id, {
        formData,
        updatedAt: now,
        locallyEditedAt: now
      })
      await db.attachments.add(reminted)
      await db.attachments.delete(attachment.id)
      return reminted
    })
  }

  if (!attachment.logSheetLocalId) return null

  return db.transaction('rw', db.attachments, db.logSheets, async () => {
    const sheet = await db.logSheets.where('localId').equals(attachment.logSheetLocalId!).first()
    if (!sheet || !canStillCarryNewReference(sheet)) return null

    const newId = uuidv4()
    const reminted: LocalAttachment = {
      ...attachment,
      id: newId,
      idRemintedFrom: attachment.id,
      syncStatus: 'pending',
      syncError: undefined,
      permanentFailure: undefined,
      failedStatus: undefined
    }
    await db.logSheets.update(sheet.id, sheetWithReferenceRewritten(sheet, attachment, newId, now))
    await db.attachments.add(reminted)
    await db.attachments.delete(attachment.id)
    return reminted
  })
}

function rewriteFormAttachmentRef(
  formData: Record<string, unknown> | undefined,
  fieldKey: string,
  oldId: string,
  newId: string
): Record<string, unknown> {
  const next = { ...(formData ?? {}) }
  const value = next[fieldKey]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ids = Array.isArray((value as { ids?: unknown }).ids)
      ? ([...(value as { ids: unknown[] }).ids] as unknown[])
      : []
    next[fieldKey] = {
      ...(value as object),
      ids: ids.map(id => (String(id) === oldId ? newId : id))
    }
  }
  return next
}
