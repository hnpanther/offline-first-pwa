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

export function stripEntryFormData(
  entries: LogSheetEntryData[]
): LogSheetEntryData[] {
  return entries.map(e => ({
    ...e,
    formData: {},
    createdAt: undefined,
    updatedAt: undefined
  }))
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
