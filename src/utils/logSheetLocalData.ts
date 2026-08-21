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
