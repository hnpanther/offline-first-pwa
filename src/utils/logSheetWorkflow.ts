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
  // A still-unsynced completed submission (final submit hit while offline, not yet
  // acknowledged by the server) must never be resolved here. Whatever the bundle currently
  // shows — server already SUBMITTED by someone else, or reassigned to someone else while
  // still open — only the batch-submit outcome may decide its fate: it is the only path
  // that actually contacts the submit endpoint and can record a server-side void on
  // conflict. Resolving it via a bundle refresh instead would silently discard the
  // operator's completed work with no error and no void record.
  if (existing.status === 'submitted' && existing.syncStatus === 'pending') {
    return null
  }

  if (serverSheet.status === 'SUBMITTED') {
    return 'mark-synced'
  }

  if (serverSheet.status === 'EXPIRED') {
    return null
  }

  // Same philosophy as EXPIRED above: a supervisor cancel is reopenable later via extend
  // (mirrors how an expired sheet is un-expired), so the local draft is left in place —
  // never silently wiped — and only flagged through `serverStatus`/chip logic.
  if (serverSheet.status === 'CANCELLED') {
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

  return null
}

/**
 * A `mark-synced` bundle refresh overwrites the local row with the server's completed
 * version. Returns true when doing so would silently destroy work this device still
 * holds — the operator filled some assets but never hit final submit, and the completion
 * now on the server belongs to somebody else — so a read-only archive copy must be taken
 * first (otherwise their readings are gone, and the live row is purged 24h later by
 * `cleanupLocalLogSheets`).
 */
export function shouldArchiveBeforeServerOverwrite(
  existing: Pick<LogSheet, 'status' | 'syncStatus' | 'entries'>,
  preserveLocal: boolean
): boolean {
  // The local work is this user's own and still matches the server assignee — nothing lost.
  if (preserveLocal) return false
  // Already reconciled: the row mirrors the server's values, so there is no unsent work
  // left to preserve. Re-archiving here would overwrite the good snapshot with the other
  // operator's data on a second pass (StrictMode, concurrent inbox refresh, later reopen).
  if (existing.status === 'submitted' && existing.syncStatus === 'synced') return false
  return sheetHasLocalEntryData(existing)
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

/**
 * Computes local field updates when a sheet reappears in this operator's own "assigned" inbox
 * bucket with a future dueAt — i.e. a supervisor genuinely reopened/extended it. Whatever stale
 * failure flag the local record is still carrying is cleared, covering two distinct cases:
 *
 * - A plain draft that expired before the operator ever got around to submitting it —
 *   `expireStaleLocalDrafts` sets `syncError` directly and never touches `syncStatus`, so
 *   gating this purely on `syncStatus === 'failed'` misses it entirely (there was no rejected
 *   submission, there was no submission at all).
 * - An already-submitted completion that got rejected (`syncStatus: 'failed'`) — only this case
 *   also needs re-queuing for retry, with a *fresh* `clientActionId`: the earlier attempt's id
 *   may already be recorded server-side as a used idempotency key (CANCELLED/SUPERSEDED both
 *   route through the server's `voidSubmission`, which records it), so reusing it would make
 *   the server's replay guard treat the retry as an already-processed duplicate and report
 *   false success without ever re-running the completion.
 */
export function resolveReopenedSheetUpdates(
  local: Pick<LogSheet, 'status' | 'syncStatus' | 'syncError'>,
  newClientActionId: () => string
): Partial<Pick<LogSheet, 'syncError' | 'syncStatus' | 'clientActionId'>> {
  const updates: Partial<Pick<LogSheet, 'syncError' | 'syncStatus' | 'clientActionId'>> = {}
  if (local.syncError != null) {
    updates.syncError = undefined
  }
  if (local.status === 'submitted' && local.syncStatus === 'failed') {
    updates.syncStatus = 'pending'
    updates.clientActionId = newClientActionId()
  }
  return updates
}
