import type { LogSheet, LogSheetEntryData } from '@/types'
import { hasEntryFormData } from '@/utils/entryTimestamps'
import { toIdString } from '@/utils/ids'

/** User who entered or submitted work on this shared device. */
export function resolveLocalWorkOwner(
  sheet: Pick<LogSheet, 'localOwnerUserId' | 'assigneeUserId'>
): string | null {
  return sheet.localOwnerUserId ?? sheet.assigneeUserId ?? null
}

export function sheetHasLocalEntryData(
  sheet: Pick<LogSheet, 'entries'>
): boolean {
  return (sheet.entries ?? []).some(e => hasEntryFormData(e.formData))
}

/** Whether the round's own questions hold an answer on this device. */
export function sheetHasRoundAnswers(sheet: Pick<LogSheet, 'sheetFormData'>): boolean {
  return hasEntryFormData(sheet.sheetFormData)
}

/**
 * Whether this row holds work worth keeping: an answered asset, or an answered question of the
 * round itself.
 *
 * <p>Every "is there anything to lose here?" decision — archive before clearing, reset a
 * reassigned draft, archive before a server overwrite, keep an archive visible — used to ask only
 * about the assets. A round answered only at round level (every asset-less round, and any round
 * where the operator started with its questions) then counted as empty: reassigning it away
 * cleared it **without an archive**, and the unsynced answers were gone. Asking this instead keeps
 * the two kinds of work on one rule.
 */
export function sheetHasLocalWork(sheet: Pick<LogSheet, 'entries' | 'sheetFormData'>): boolean {
  return sheetHasLocalEntryData(sheet) || sheetHasRoundAnswers(sheet)
}

/**
 * Does the archive hold an answered round question the live row has nothing for?
 *
 * <p>Per question, for the same reason {@link archiveHoldsWorkTheLiveRowLacks} is per asset: a
 * live row that holds some answers must not hide an archive that holds others.
 */
export function archiveHoldsRoundAnswersTheLiveRowLacks(
  archived: Pick<LogSheet, 'sheetFormData'>,
  liveRow: Pick<LogSheet, 'sheetFormData'>
): boolean {
  const live = liveRow.sheetFormData ?? {}
  return Object.entries(archived.sheetFormData ?? {}).some(
    ([key, value]) => hasEntryFormData({ [key]: value }) && !hasEntryFormData({ [key]: live[key] })
  )
}

/**
 * Does the archive still hold an answered asset the live row has nothing for?
 *
 * <p>The question the archive's visibility actually turns on, and it is not the same as "does the
 * live row hold anything". A **partial** restore leaves the live row holding the assets that were
 * brought back and the archive holding the ones that were not — and a rule that asked only
 * whether the live row had data would hide the archive at that moment, stranding the rest exactly
 * the way the original bug stranded everything. Found by running a two-pass restore, not by a
 * test: the card vanished after the first pass.
 *
 * <p>Per asset, because that is the granularity a restore works at.
 */
export function archiveHoldsWorkTheLiveRowLacks(
  archived: Pick<LogSheet, 'entries'>,
  liveRow: Pick<LogSheet, 'entries'>
): boolean {
  const liveByAsset = new Map(
    (liveRow.entries ?? []).map(e => [toIdString(e.assetId), e])
  )
  return (archived.entries ?? []).some(entry => {
    if (!hasEntryFormData(entry.formData)) return false
    const live = liveByAsset.get(toIdString(entry.assetId))
    return !live || !hasEntryFormData(live.formData)
  })
}

export function stripEntryFormData(
  entries: LogSheetEntryData[]
): LogSheetEntryData[] {
  return entries.map(e => ({
    ...e,
    formData: {},
    createdAt: undefined,
    updatedAt: undefined,
    filledVia: undefined,
    locallyEditedAt: undefined
  }))
}

/**
 * Forgets that this device had an opinion about these entries.
 *
 * <p>Called wherever the device's work stops being its own: the server accepted it, or the row
 * is being reset for a fresh editing session. **This is the half of `locallyEditedAt` that keeps
 * it safe.** A marker that outlives its submission makes the device win that entry on every
 * future merge, so a supervisor who edits the sheet afterwards becomes invisible — which is the
 * log sheet 85 bug again, arrived at from the other direction.
 *
 * <p>Returns the same array identity-wise only when nothing had a marker, so an unnecessary
 * IndexedDB write is easy for a caller to skip.
 */
export function clearLocalEditMarkers(
  entries: LogSheetEntryData[] | undefined
): LogSheetEntryData[] {
  const list = entries ?? []
  if (!list.some(e => e.locallyEditedAt != null)) return list
  return list.map(e => (e.locallyEditedAt == null ? e : { ...e, locallyEditedAt: undefined }))
}

export function serverAssigneeId(
  assigneeUserId?: number | string | null
): string | null {
  if (assigneeUserId == null) return null
  return toIdString(assigneeUserId)
}

export function isAssigneeMismatch(
  local: Pick<LogSheet, 'assigneeUserId' | 'localOwnerUserId'>,
  serverAssignee: string | null
): boolean {
  if (!serverAssignee) return false
  const localAssignee = local.assigneeUserId ?? null
  const localOwner = local.localOwnerUserId ?? null
  if (localAssignee && localAssignee !== serverAssignee) return true
  if (localOwner && localOwner !== serverAssignee) return true
  return false
}
