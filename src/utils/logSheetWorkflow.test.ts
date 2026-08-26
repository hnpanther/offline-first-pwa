import { describe, expect, it } from 'vitest'
import {
  alignLocalWorkflowWithServer,
  shouldPreserveLocalFormData,
  shouldArchiveBeforeServerOverwrite,
  revivalUpdatesAfterReassign,
  resolveReopenedSheetUpdates,
  canContinueReopenedLogSheet
} from '@/utils/logSheetWorkflow'
import type { LogSheet } from '@/types'
import type { ServerLogSheet } from '@/services/api'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'

function baseLocal(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'id-1',
    localId: 'local-1',
    serverId: '100',
    templateId: '1',
    templateName: 'Test',
    scopeSummary: '',
    status: 'draft',
    syncStatus: 'synced',
    entries: [{ assetId: '1', assetName: 'A', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: { x: 1 } }],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function baseServer(overrides: Partial<ServerLogSheet> = {}): ServerLogSheet {
  return {
    id: 100,
    templateId: 1,
    templateName: 'Test',
    scopeSummary: '',
    status: 'ASSIGNED',
    assigneeUserId: 2,
    ...overrides
  }
}

describe('alignLocalWorkflowWithServer', () => {
  it('resets draft when assignee changed and local has entry data', () => {
    const local = baseLocal({
      assigneeUserId: '1',
      localOwnerUserId: '1',
      status: 'draft'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'ASSIGNED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBe('reset-draft')
  })

  it('never resolves a still-unsynced pending submission via bundle refresh, even on assignee mismatch', () => {
    // Regression: operator1 completes offline and hits final submit (status='submitted',
    // syncStatus='pending'), a supervisor reassigns to operator2 while operator1 is still
    // offline, then operator1's device fetches a fresh bundle before the outbound sync gets
    // a chance to run. The old 'reset-draft' behavior here silently wiped operator1's
    // completed work with no error and no server-side void record, since a bundle GET never
    // contacts the submit endpoint. Only the batch-submit outcome may resolve this sheet now.
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'pending',
      assigneeUserId: '1',
      localOwnerUserId: '1'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'IN_PROGRESS' })

    expect(alignLocalWorkflowWithServer(local, server)).toBeNull()
  })

  it('never resolves a still-unsynced pending submission via bundle refresh, even when server already shows SUBMITTED', () => {
    // Same regression, other half: by the time operator1 comes online, operator2 may have
    // already completed and submitted (server status SUBMITTED). The old 'mark-synced'
    // behavior here blindly assumed the SUBMITTED status was operator1's own — silently
    // discarding operator1's real data as if it had synced successfully, with no error at
    // all. Only the batch-submit outcome (which can tell CREATED/DUPLICATE from SUPERSEDED)
    // may resolve it.
    const local = baseLocal({ status: 'submitted', syncStatus: 'pending' })
    const server = baseServer({ status: 'SUBMITTED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBeNull()
  })

  it('keeps local synced sheet when inbox lag still shows open for same assignee', () => {
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'synced',
      assigneeUserId: '2',
      localOwnerUserId: '2'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'IN_PROGRESS' })

    expect(alignLocalWorkflowWithServer(local, server)).toBeNull()
  })

  it('resets synced sheet only when assignee actually changed', () => {
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'synced',
      assigneeUserId: '1',
      localOwnerUserId: '1'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'IN_PROGRESS' })

    expect(alignLocalWorkflowWithServer(local, server)).toBe('reset-draft')
  })

  it('never wipes a local draft when the server sheet was cancelled, same as EXPIRED', () => {
    const local = baseLocal({
      status: 'draft',
      assigneeUserId: '2',
      localOwnerUserId: '2'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'CANCELLED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBeNull()
  })

  /**
   * The failure mode APPROVED introduced, and the reason `isCompletedServerStatus` exists.
   *
   * An unhandled status falls through every branch to `return null`, which means "nothing to do"
   * — so the device keeps a stale local draft alive and editable for a round the server has
   * closed. The operator edits it, submits, the server voids it as superseded, and from their
   * side the work simply vanished. Approval is a review laid on top of completion, not a
   * different kind of completion, so it has to resolve exactly as SUBMITTED does.
   */
  it('marks a synced local sheet as delivered when the server has APPROVED it', () => {
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'synced',
      assigneeUserId: '2',
      localOwnerUserId: '2'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'APPROVED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBe('mark-synced')
    // ...and identically for SUBMITTED, which is the point: the two must not diverge.
    expect(alignLocalWorkflowWithServer(local, baseServer({ assigneeUserId: 2, status: 'SUBMITTED' })))
      .toBe('mark-synced')
  })

  it('an APPROVED server sheet resolves a local draft the same way a SUBMITTED one does', () => {
    const local = baseLocal({ status: 'draft', assigneeUserId: '2', localOwnerUserId: '2' })

    expect(alignLocalWorkflowWithServer(local, baseServer({ assigneeUserId: 2, status: 'APPROVED' })))
      .toBe('mark-synced')
  })

  /**
   * The other half of the pending-submission guarantee. An operator whose own submission has not
   * left the device must not have it silently discarded because somebody else's round reached
   * APPROVED — exactly the regression already pinned for SUBMITTED above.
   */
  it('never resolves a still-unsynced pending submission because the server shows APPROVED', () => {
    const local = baseLocal({ status: 'submitted', syncStatus: 'pending' })

    expect(alignLocalWorkflowWithServer(local, baseServer({ status: 'APPROVED' }))).toBeNull()
  })

  it('does not reset a cancelled sheet even if the assignee also changed', () => {
    // The CANCELLED early-return must win before any assignee-mismatch reset logic runs —
    // a cancelled sheet's data must never be silently wiped, matching EXPIRED's guarantee.
    const local = baseLocal({
      status: 'draft',
      assigneeUserId: '1',
      localOwnerUserId: '1'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'CANCELLED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBeNull()
  })
})

describe('shouldArchiveBeforeServerOverwrite', () => {
  const filled = baseLocal({ status: 'draft', entries: [{ assetId: '1', assetName: 'A', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: { temp: 22 } }] })
  const empty = baseLocal({ status: 'draft', entries: [{ assetId: '1', assetName: 'A', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: {} }] })

  it('archives a part-filled draft that a stranger already completed on the server', () => {
    // The reported bug: the operator filled a few assets but never hit final submit, a
    // supervisor took the sheet over and it got completed by someone else. Without the
    // archive their readings are replaced by the other person's and then purged in 24h.
    expect(shouldArchiveBeforeServerOverwrite(filled, false)).toBe(true)
  })

  it('does not archive when the local work is the user own and still matches the server', () => {
    expect(shouldArchiveBeforeServerOverwrite(filled, true)).toBe(false)
  })

  it('does not archive a draft with nothing filled in yet', () => {
    expect(shouldArchiveBeforeServerOverwrite(empty, false)).toBe(false)
  })

  it('does not re-archive a row already reconciled with the server', () => {
    // Guards the second pass (StrictMode double-effect / concurrent inbox refresh /
    // reopening later): the row now holds the *server* values, so archiving again would
    // overwrite the good snapshot with the other operator's data.
    const reconciled = baseLocal({
      status: 'submitted',
      syncStatus: 'synced',
      entries: [{ assetId: '1', assetName: 'A', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: { temp: 99 } }]
    })
    expect(shouldArchiveBeforeServerOverwrite(reconciled, false)).toBe(false)
  })

  it('archives an unsynced completion that is being overwritten', () => {
    const submittedFailed = baseLocal({
      status: 'submitted',
      syncStatus: 'failed',
      entries: [{ assetId: '1', assetName: 'A', subFunctionCode: '', subFunctionTag: '', classId: '1', formData: { temp: 5 } }]
    })
    expect(shouldArchiveBeforeServerOverwrite(submittedFailed, false)).toBe(true)
  })
})

describe('shouldPreserveLocalFormData', () => {
  it('returns false when session user does not own local work', () => {
    const local = baseLocal({ localOwnerUserId: '1', assigneeUserId: '1' })
    const server = baseServer({ assigneeUserId: 1 })

    expect(shouldPreserveLocalFormData(local, server, '2')).toBe(false)
  })

  it('returns false when owner no longer matches server assignee', () => {
    const local = baseLocal({ localOwnerUserId: '1', assigneeUserId: '1' })
    const server = baseServer({ assigneeUserId: 2 })

    expect(shouldPreserveLocalFormData(local, server, '1')).toBe(false)
  })

  it('returns true when session user owns work and assignee matches', () => {
    const local = baseLocal({ localOwnerUserId: '2', assigneeUserId: '2' })
    const server = baseServer({ assigneeUserId: 2 })

    expect(shouldPreserveLocalFormData(local, server, '2')).toBe(true)
  })
})

describe('revivalUpdatesAfterReassign', () => {
  it('revives pending submit when ownership error cleared after reassign back', () => {
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.REVOKED,
      localOwnerUserId: '2',
      assigneeUserId: '2'
    })
    const server = baseServer({ assigneeUserId: 2 })

    const updates = revivalUpdatesAfterReassign(local, server, () => 'new-action-id')

    expect(updates).toMatchObject({
      syncError: undefined,
      syncStatus: 'pending',
      clientActionId: 'new-action-id'
    })
  })
})

describe('resolveReopenedSheetUpdates', () => {
  // Regression guard: an operator claims/is assigned a task, it expires before they ever
  // submit it (a plain draft — no failed submission attempt, so syncStatus was never touched),
  // a supervisor extends the deadline. The draft must become editable again.
  it('clears syncError on a plain draft that expired before ever being submitted', () => {
    const local = { status: 'draft' as const, syncStatus: undefined, syncError: SYNC_OUTCOME_MESSAGES.EXPIRED }

    const updates = resolveReopenedSheetUpdates(local, () => 'unused')

    expect(updates).toEqual({ syncError: undefined })
  })

  it('clears a backend-translated syncError on a draft too, not just this client\'s own constants', () => {
    const local = {
      status: 'draft' as const,
      syncStatus: undefined,
      syncError: 'این لاگ‌شیت توسط سرپرست لغو شده است.'
    }

    const updates = resolveReopenedSheetUpdates(local, () => 'unused')

    expect(updates).toEqual({ syncError: undefined })
  })

  it('re-queues an already-submitted-but-rejected sheet with a fresh clientActionId', () => {
    const local = { status: 'submitted' as const, syncStatus: 'failed' as const, syncError: SYNC_OUTCOME_MESSAGES.CANCELLED }

    const updates = resolveReopenedSheetUpdates(local, () => 'fresh-action-id')

    expect(updates).toEqual({ syncError: undefined, syncStatus: 'pending', clientActionId: 'fresh-action-id' })
  })

  it('does not re-queue a still-editable draft even if it happens to carry a syncError', () => {
    const local = { status: 'draft' as const, syncStatus: 'pending' as const, syncError: SYNC_OUTCOME_MESSAGES.EXPIRED }

    const updates = resolveReopenedSheetUpdates(local, () => 'unused')

    expect(updates).toEqual({ syncError: undefined })
    expect(updates.syncStatus).toBeUndefined()
    expect(updates.clientActionId).toBeUndefined()
  })

  it('is a no-op for an already-healthy sheet with no syncError', () => {
    const local = { status: 'draft' as const, syncStatus: 'pending' as const, syncError: undefined }

    const updates = resolveReopenedSheetUpdates(local, () => 'unused')

    expect(updates).toEqual({})
  })
})

/**
 * Resuming a completion a supervisor reopened.
 *
 * Every case here is judged against a **freshly fetched** bundle, which is the whole point of
 * the guard: the inbox response that flagged the sheet as reopened may have been read from the
 * server moments before this device's own submission landed, and acting on that stale picture
 * would reopen work the server had already closed.
 */
describe('canContinueReopenedLogSheet', () => {
  const me = '2'
  const future = Date.now() + 6 * 60 * 60 * 1000
  const reopenedServer = (overrides: Partial<ServerLogSheet> = {}) =>
    baseServer({ status: 'IN_PROGRESS', assigneeUserId: 2, dueAt: future, ...overrides })

  it('allows the assignee to resume an IN_PROGRESS sheet with a future deadline', () => {
    expect(canContinueReopenedLogSheet(reopenedServer(), me)).toEqual({ ok: true })
  })

  it('allows the ASSIGNED variant as well', () => {
    expect(canContinueReopenedLogSheet(reopenedServer({ status: 'ASSIGNED' }), me).ok).toBe(true)
  })

  it('refuses when the server still holds the sheet as SUBMITTED — the submit/inbox race', () => {
    // The exact case the live re-check exists for: an inbox response fetched just before this
    // device's submission landed still shows the sheet open. Reopening on that would let the
    // operator edit a completed sheet and earn a DUPLICATE/SUPERSEDED refusal on resubmit.
    const result = canContinueReopenedLogSheet(reopenedServer({ status: 'SUBMITTED' }), me)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ثبت نهایی')
  })

  /**
   * And the same refusal once a supervisor has approved it. A round that has been reviewed and
   * accepted is further from reopenable than a merely completed one, so the branch that refuses
   * SUBMITTED must cover APPROVED or the operator is invited to edit a closed round and earns a
   * SUPERSEDED refusal for their trouble.
   */
  it('refuses an APPROVED sheet for the same reason it refuses a SUBMITTED one', () => {
    const result = canContinueReopenedLogSheet(reopenedServer({ status: 'APPROVED' }), me)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ثبت نهایی')
  })

  it('refuses a cancelled sheet with the cancellation reason, not a generic one', () => {
    const result = canContinueReopenedLogSheet(reopenedServer({ status: 'CANCELLED' }), me)

    expect(result).toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.CANCELLED })
  })

  it('refuses an expired sheet with the expiry reason', () => {
    const result = canContinueReopenedLogSheet(reopenedServer({ status: 'EXPIRED' }), me)

    expect(result).toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED })
  })

  it('refuses a sheet reopened back into the pool — it has to be claimed, not resumed', () => {
    const result = canContinueReopenedLogSheet(
      reopenedServer({ status: 'PENDING', assigneeUserId: null }),
      me
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('این کار در کارتابل شما باز نیست.')
  })

  it('refuses when the sheet now belongs to another operator', () => {
    const result = canContinueReopenedLogSheet(reopenedServer({ assigneeUserId: 9 }), me)

    expect(result).toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.REASSIGNED })
  })

  it('refuses when the sheet is open but unassigned', () => {
    const result = canContinueReopenedLogSheet(reopenedServer({ assigneeUserId: null }), me)

    expect(result).toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.REASSIGNED })
  })

  it('refuses once the reopened deadline has passed, and when there is none at all', () => {
    expect(canContinueReopenedLogSheet(reopenedServer({ dueAt: Date.now() - 1 }), me))
      .toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED })
    expect(canContinueReopenedLogSheet(reopenedServer({ dueAt: null }), me))
      .toEqual({ ok: false, reason: SYNC_OUTCOME_MESSAGES.EXPIRED })
  })

  it('refuses while the session has no resolved user id', () => {
    // Same rule as the rest of the app: work that cannot be attributed is not acted on.
    const result = canContinueReopenedLogSheet(reopenedServer(), null)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('شناسایی نشد')
  })

  it('compares assignee ids across types, not by identity', () => {
    // Server sends a number, the session holds a string.
    expect(canContinueReopenedLogSheet(reopenedServer({ assigneeUserId: 2 }), '2').ok).toBe(true)
  })
})

/**
 * The backend dropped `log_sheets.local_id` and `log_sheets.sync_error` — both were dead
 * columns it never wrote. Several endpoints serialize the LogSheet entity directly, so those
 * two keys are now simply ABSENT from the JSON instead of present-and-null.
 *
 * These cases pin that the PWA does not care. If someone later starts reading either field
 * off a server sheet, one of these fails instead of the behaviour silently drifting.
 */
describe('server sheets without the removed local_id / sync_error fields', () => {
  it('alignLocalWorkflowWithServer behaves identically whether the fields are null or absent', () => {
    const local = baseLocal({
      assigneeUserId: '1',
      status: 'draft',
      syncStatus: 'pending',
      entries: [{ assetId: '1', assetName: 'A', classId: '1', formData: { v: 1 } }]
    })

    const withNulls = baseServer({ assigneeUserId: 2, localId: null, syncError: null })
    const withoutKeys = baseServer({ assigneeUserId: 2 })
    expect('localId' in withoutKeys).toBe(false)
    expect('syncError' in withoutKeys).toBe(false)

    expect(alignLocalWorkflowWithServer(local, withoutKeys))
      .toEqual(alignLocalWorkflowWithServer(local, withNulls))
  })

  it('revivalUpdatesAfterReassign behaves identically whether the fields are null or absent', () => {
    const local = baseLocal({
      assigneeUserId: '2',
      localOwnerUserId: '2',
      status: 'draft',
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.OWNERSHIP_REASSIGNED
    })

    const withNulls = baseServer({ assigneeUserId: 2, localId: null, syncError: null })
    const withoutKeys = baseServer({ assigneeUserId: 2 })

    expect(revivalUpdatesAfterReassign(local, withoutKeys, () => 'fixed-id'))
      .toEqual(revivalUpdatesAfterReassign(local, withNulls, () => 'fixed-id'))
  })

  it('a local sheet still owns its own localId and syncError regardless of the server', () => {
    // These stayed client-side concerns: localId is the Dexie key, syncError is written from
    // sync outcomes. Nothing about them was ever sourced from the server payload.
    const local = baseLocal({ localId: 'local-key-1', syncError: SYNC_OUTCOME_MESSAGES.EXPIRED })

    expect(local.localId).toBe('local-key-1')
    expect(local.syncError).toBe(SYNC_OUTCOME_MESSAGES.EXPIRED)
  })
})
