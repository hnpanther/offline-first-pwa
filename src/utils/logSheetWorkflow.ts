import type { LogSheet } from '@/types'
import type { ServerLogSheet } from '@/services/api'
import {
  isAssigneeMismatch,
  resolveLocalWorkOwner,
  serverAssigneeId,
  sheetHasLocalEntryData
} from '@/utils/logSheetLocalData'
import { isOwnershipReassignError } from '@/utils/logSheetStatus'

/** Drop stale local completion when the server still has the sheet open. */
export function alignLocalWorkflowWithServer(
  existing: LogSheet,
  serverSheet: ServerLogSheet
): 'reset-draft' | 'mark-synced' | null {
  if (serverSheet.status === 'SUBMITTED') {
    return 'mark-synced'
  }

  if (serverSheet.status === 'EXPIRED') {
    return null
  }

  const serverStillOpen =
    serverSheet.status === 'ASSIGNED' ||
    serverSheet.status === 'IN_PROGRESS' ||
    serverSheet.status === 'PENDING' ||
    serverSheet.status == null

  if (!serverStillOpen) return null

  const serverAssignee = serverAssigneeId(serverSheet.assigneeUserId)
  const assigneeMismatch = isAssigneeMismatch(existing, serverAssignee)

  // Local already synced successfully — do not wipe it just because inbox lag still
  // shows the sheet as open. Only clear when ownership actually moved away.
  if (existing.syncStatus === 'synced') {
    return assigneeMismatch ? 'reset-draft' : null
  }

  if (assigneeMismatch && existing.status === 'submitted') {
    return 'reset-draft'
  }

  if (
    assigneeMismatch &&
    existing.status === 'draft' &&
    sheetHasLocalEntryData(existing)
  ) {
    return 'reset-draft'
  }

  if (
    existing.syncStatus === 'failed' &&
    isOwnershipReassignError(existing.syncError) &&
    assigneeMismatch
  ) {
    return 'reset-draft'
  }

  if (existing.status === 'submitted' && existing.syncStatus === 'pending') {
    if (assigneeMismatch) return 'reset-draft'
    const owner = resolveLocalWorkOwner(existing)
    if (owner && serverAssignee && owner !== serverAssignee) {
      return 'reset-draft'
    }
    return null
  }

  return null
}

/** Keep local form data only when the current session user owns the local work. */
export function shouldPreserveLocalFormData(
  existing: LogSheet | undefined,
  serverSheet: ServerLogSheet,
  sessionUserId: string | null
): boolean {
  if (!existing || !sessionUserId) return false
  const owner = resolveLocalWorkOwner(existing)
  if (!owner || owner !== sessionUserId) return false
  const serverAssignee = serverAssigneeId(serverSheet.assigneeUserId)
  if (serverAssignee && owner !== serverAssignee) return false
  return true
}

export function revivalUpdatesAfterReassign(
  local: LogSheet,
  serverSheet: ServerLogSheet,
  newClientActionId: () => string
): Partial<LogSheet> | null {
  if (!isOwnershipReassignError(local.syncError)) return null

  const serverAssignee = serverAssigneeId(serverSheet.assigneeUserId)
  const localUser = resolveLocalWorkOwner(local)
  if (!serverAssignee || !localUser || localUser !== serverAssignee) {
    return null
  }

  const updates: Partial<LogSheet> = { syncError: undefined }
  if (local.syncStatus === 'failed' || (local.status === 'submitted' && local.syncStatus !== 'synced')) {
    updates.syncStatus = 'pending'
  }
  if (local.status === 'submitted') {
    updates.clientActionId = newClientActionId()
  }
  return updates
}
