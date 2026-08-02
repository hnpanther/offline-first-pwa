import { describe, expect, it } from 'vitest'
import { isArchivedSubmissionPendingServerOutcome } from '@/services/storage/logSheetArchive'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import type { LogSheet } from '@/types'

type ArchivedSnapshot = Parameters<typeof isArchivedSubmissionPendingServerOutcome>[0]

const NOW = 1_700_000_000_000

function archived(overrides: Partial<LogSheet> = {}): ArchivedSnapshot {
  return {
    serverId: '1',
    status: 'submitted',
    syncStatus: 'failed',
    serverStatus: 'IN_PROGRESS',
    syncError: SYNC_OUTCOME_MESSAGES.REASSIGNED,
    syncedAt: undefined,
    dueAt: NOW + 60_000,
    completedAt: NOW - 60_000,
    submittedAt: NOW - 60_000,
    ...overrides
  }
}

describe('isArchivedSubmissionPendingServerOutcome', () => {
  it('pushes work archived when another operator took the sheet over on this device', () => {
    // The reported bug: operator1 completes offline, logs out while still offline, a
    // supervisor reassigns, operator2 completes on the same device. Operator1's work is
    // detached from the live logSheets row into an archive — it must still reach the
    // server so a void submission gets recorded.
    expect(isArchivedSubmissionPendingServerOutcome(archived(), NOW)).toBe(true)
  })

  it('does not re-push once the server has already responded (syncedAt set)', () => {
    // syncedAt is the resolution marker — without it a rejected push would retry forever.
    expect(
      isArchivedSubmissionPendingServerOutcome(archived({ syncedAt: NOW }), NOW)
    ).toBe(false)
  })

  it('does not push work the server already accepted', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(archived({ syncStatus: 'synced' }), NOW)
    ).toBe(false)
  })

  it('does not push an already-superseded submission', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(
        archived({ serverStatus: 'SUBMITTED', syncError: SYNC_OUTCOME_MESSAGES.SUPERSEDED }),
        NOW
      )
    ).toBe(false)
  })

  it('does not push a draft that was never completed', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(archived({ status: 'draft' }), NOW)
    ).toBe(false)
  })

  it('does not push a submission the server expired', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(archived({ serverStatus: 'EXPIRED' }), NOW)
    ).toBe(false)
  })

  it('still pushes an on-time offline completion after the deadline has passed', () => {
    // Matches isLogSheetExpiredForSync: the deadline is judged on device completion time,
    // so coming back online late does not forfeit the void record.
    expect(
      isArchivedSubmissionPendingServerOutcome(
        archived({ completedAt: NOW - 60_000, submittedAt: NOW - 60_000, dueAt: NOW - 30_000 }),
        NOW
      )
    ).toBe(true)
  })

  it('does not push a completion made after the deadline', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(
        archived({ completedAt: NOW, submittedAt: NOW, dueAt: NOW - 30_000 }),
        NOW
      )
    ).toBe(false)
  })

  it('does not push a sheet that never reached the server (no serverId)', () => {
    expect(
      isArchivedSubmissionPendingServerOutcome(archived({ serverId: undefined }), NOW)
    ).toBe(false)
  })
})
