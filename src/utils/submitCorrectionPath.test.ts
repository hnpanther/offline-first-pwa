import { describe, expect, it } from 'vitest'
import {
  canRevertSubmittedLogSheetToDraft,
  canSubmitLogSheet,
  failedOnFieldValidation,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { FieldDefinition } from '@/types/sync'
import type { LogSheet } from '@/types'

/**
 * The correction path for a submission the server refused.
 *
 * The design in one line: **prevent, then cure**. Prevent by refusing a submit the server would
 * certainly reject, while the operator is still on the form. Cure — for the one rejection that
 * is theirs to fix — by letting them reopen, edit and resubmit.
 *
 * A retry button was deliberately not built. It would re-send an identical payload for an
 * identical refusal while displaying "trying again…", and if it reused the stale
 * `clientActionId` the server's replay guard would report the submission as already processed —
 * false success on top of false hope.
 *
 * The three other rejections (no server id, sheet deleted server-side, asset mismatch) stay
 * closed: an operator cannot fix them, and a control implying they can is worse than none.
 */

const HOUR = 3_600_000

function defs(): FieldDefinition[] {
  return [
    { id: '1', classId: '2', key: 'temp', label: 'دما', dataType: 'number', required: true, order: 1, deleted: false },
    { id: '2', classId: '2', key: 'note', label: 'یادداشت', dataType: 'text', required: false, order: 2, deleted: false }
  ] as FieldDefinition[]
}

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    localId: 'local-1',
    serverId: '55',
    status: 'submitted',
    syncStatus: 'pending',
    dueAt: Date.now() + 4 * HOUR,
    entries: [{ assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { temp: 42 } }],
    fieldDefinitions: defs(),
    ...overrides
  } as LogSheet
}

// ---------------------------------------------------------------------------
// Prevention
// ---------------------------------------------------------------------------

describe('canSubmitLogSheet — the prevention gate', () => {
  it('allows a sheet whose required fields are answered', () => {
    expect(canSubmitLogSheet(sheet()).ok).toBe(true)
  })

  it('refuses a sheet the server would reject, naming the field', () => {
    const result = canSubmitLogSheet(
      sheet({ entries: [{ assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { note: 'x' } }] } as Partial<LogSheet>)
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('دما')
    expect(result.reason).toContain('پمپ ۱')
  })

  it('still allows a sheet with untouched assets', () => {
    // The everyday case: a 50-asset round where some equipment was not reached. The server
    // skips blank entries, so blocking here would make normal work unsubmittable.
    const result = canSubmitLogSheet(
      sheet({
        entries: [
          { assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { temp: 42 } },
          { assetId: '8', assetName: 'پمپ ۲', classId: '2', formData: {} }
        ]
      } as Partial<LogSheet>)
    )
    expect(result.ok).toBe(true)
  })

  it('allows a sheet whose schema this device does not have', () => {
    // Never trap an operator over data the *device* is missing; the server is the authority.
    expect(canSubmitLogSheet(sheet({ fieldDefinitions: [] })).ok).toBe(true)
  })

  it('keeps lifecycle refusals ahead of the value check', () => {
    // A cancelled sheet must say "cancelled", not "your دما field is empty" — the operator
    // would otherwise fix fields for a sheet that can never be submitted.
    const cancelled = canSubmitLogSheet(
      sheet({
        serverStatus: 'CANCELLED',
        entries: [{ assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { note: 'x' } }]
      } as Partial<LogSheet>)
    )
    expect(cancelled.ok).toBe(false)
    expect(cancelled.reason).toBe(SYNC_OUTCOME_MESSAGES.CANCELLED)
  })

  it('keeps the expiry refusal ahead of the value check', () => {
    const expired = canSubmitLogSheet(
      sheet({
        dueAt: Date.now() - HOUR,
        entries: [{ assetId: '7', assetName: 'پمپ ۱', classId: '2', formData: { note: 'x' } }]
      } as Partial<LogSheet>)
    )
    expect(expired.ok).toBe(false)
    expect(expired.reason).toBe(SYNC_OUTCOME_MESSAGES.EXPIRED)
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('failedOnFieldValidation', () => {
  it('is true only for a validation rejection', () => {
    expect(failedOnFieldValidation({ syncStatus: 'failed', lastSubmitOutcome: 'VALIDATION_ERROR' })).toBe(true)
  })

  it('is false for the rejections an operator cannot fix', () => {
    // A deleted sheet or an asset mismatch is supervisor territory. Opening the edit control
    // here would promise a fix that does not exist.
    for (const outcome of ['ERROR', 'SUPERSEDED', 'EXPIRED', 'CANCELLED', undefined]) {
      expect(failedOnFieldValidation({ syncStatus: 'failed', lastSubmitOutcome: outcome })).toBe(false)
    }
  })

  it('is false while the submission is still queued', () => {
    // Transient trouble — a dropped link, a 5xx — never reaches `failed`; the sheet stays
    // pending and the sync timer retries it. Automatic retry already exists for those.
    expect(failedOnFieldValidation({ syncStatus: 'pending', lastSubmitOutcome: 'VALIDATION_ERROR' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cure
// ---------------------------------------------------------------------------

describe('canRevertSubmittedLogSheetToDraft — the correction path', () => {
  const rejected = () =>
    sheet({ syncStatus: 'failed', lastSubmitOutcome: 'VALIDATION_ERROR' })

  it('opens for a validation rejection even while online', () => {
    // The pre-existing rule was "offline only", which fits undoing an unsent completion. This
    // sheet is different: the server has already answered, and the fix requires being able to
    // edit — waiting for the operator to lose signal would be absurd.
    expect(canRevertSubmittedLogSheetToDraft(rejected(), false).ok).toBe(true)
  })

  it('opens from failed, not just pending', () => {
    expect(canRevertSubmittedLogSheetToDraft(rejected(), true).ok).toBe(true)
  })

  it('stays shut for the rejections an operator cannot fix', () => {
    const other = sheet({ syncStatus: 'failed', lastSubmitOutcome: 'ERROR' })
    expect(canRevertSubmittedLogSheetToDraft(other, false).ok).toBe(false)
  })

  it('stays shut once the deadline has passed', () => {
    // Editing would be wasted work: nobody can submit this sheet any more.
    const result = canRevertSubmittedLogSheetToDraft(
      sheet({ syncStatus: 'failed', lastSubmitOutcome: 'VALIDATION_ERROR', dueAt: Date.now() - HOUR }),
      false
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(SYNC_OUTCOME_MESSAGES.EXPIRED)
  })

  it('stays shut for a cancelled sheet', () => {
    const result = canRevertSubmittedLogSheetToDraft(
      sheet({ syncStatus: 'failed', lastSubmitOutcome: 'VALIDATION_ERROR', serverStatus: 'CANCELLED' }),
      false
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(SYNC_OUTCOME_MESSAGES.CANCELLED)
  })

  it('leaves the original offline-undo behaviour untouched', () => {
    expect(canRevertSubmittedLogSheetToDraft(sheet(), true).ok).toBe(true)
    expect(canRevertSubmittedLogSheetToDraft(sheet(), false).ok).toBe(false)
    expect(canRevertSubmittedLogSheetToDraft(sheet({ syncStatus: 'synced' }), true).ok).toBe(false)
  })

  it('never opens for a draft', () => {
    expect(canRevertSubmittedLogSheetToDraft(sheet({ status: 'draft' }), true).ok).toBe(false)
  })
})
