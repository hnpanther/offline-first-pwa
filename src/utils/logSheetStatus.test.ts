import { describe, expect, it } from 'vitest'
import { archivedLogSheetViewId } from '@/services/storage/logSheetArchive'
import {
  isHistoryLogSheet,
  isActiveLogSheet,
  resolveLocalLogSheetStatusChip,
  isLogSheetCancelled,
  isCancelledDraft,
  isSupersededSyncError,
  isInvalidLocalLogSheet,
  canSubmitLogSheet,
  syncOutcomeMessage,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { LogSheet } from '@/types'

function baseSheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'id-1',
    localId: 'local-1',
    serverId: '100',
    templateId: '1',
    templateName: 'Test',
    scopeSummary: '',
    status: 'submitted',
    syncStatus: 'pending',
    entries: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('isHistoryLogSheet', () => {
  it('treats archived view ids as history with reassigned chip when marked reassigned', () => {
    const sheet = baseSheet({
      localId: archivedLogSheetViewId('100', '1'),
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.REASSIGNED
    })

    expect(isHistoryLogSheet(sheet)).toBe(true)
    expect(isActiveLogSheet(sheet)).toBe(false)
    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('واگذار شده به اپراتور دیگر')
  })

  it('shows archived completed work as sent', () => {
    const sheet = baseSheet({
      localId: archivedLogSheetViewId('100', '1'),
      status: 'submitted',
      syncStatus: 'synced',
      syncError: undefined
    })

    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('ارسال شده')
  })

  it('treats revoked submitted sheets as history', () => {
    const sheet = baseSheet({
      syncStatus: 'failed',
      syncError: SYNC_OUTCOME_MESSAGES.REVOKED
    })

    expect(isHistoryLogSheet(sheet)).toBe(true)
    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('واگذار شده به اپراتور دیگر')
  })

  it('prefers synced chip over stale revoke flag', () => {
    const sheet = baseSheet({
      syncStatus: 'synced',
      syncError: SYNC_OUTCOME_MESSAGES.REVOKED
    })

    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('ارسال شده')
  })
})

describe('CANCELLED handling', () => {
  it('isLogSheetCancelled reflects serverStatus regardless of local status', () => {
    expect(isLogSheetCancelled(baseSheet({ serverStatus: 'CANCELLED' }))).toBe(true)
    expect(isLogSheetCancelled(baseSheet({ serverStatus: 'IN_PROGRESS' }))).toBe(false)
    expect(isLogSheetCancelled(baseSheet({ serverStatus: undefined }))).toBe(false)
  })

  it('isCancelledDraft only applies to local drafts, by serverStatus or a stale syncError', () => {
    expect(isCancelledDraft(baseSheet({ status: 'draft', serverStatus: 'CANCELLED' }))).toBe(true)
    expect(
      isCancelledDraft(baseSheet({ status: 'draft', syncError: SYNC_OUTCOME_MESSAGES.CANCELLED }))
    ).toBe(true)
    expect(isCancelledDraft(baseSheet({ status: 'draft', serverStatus: 'PENDING' }))).toBe(false)
    // Submitted sheets are covered by isLogSheetCancelled instead, not this predicate.
    expect(isCancelledDraft(baseSheet({ status: 'submitted', serverStatus: 'CANCELLED' }))).toBe(false)
  })

  it('a cancelled draft moves to history and out of the active list', () => {
    const sheet = baseSheet({ status: 'draft', serverStatus: 'CANCELLED' })

    expect(isActiveLogSheet(sheet)).toBe(false)
    expect(isHistoryLogSheet(sheet)).toBe(true)
  })

  it('a cancelled draft gets its own distinct chip, not the generic draft chip', () => {
    const sheet = baseSheet({ status: 'draft', serverStatus: 'CANCELLED' })

    const chip = resolveLocalLogSheetStatusChip(sheet)
    expect(chip.label).toBe('لغو شده توسط سرپرست')
    expect(chip.color).toBe('error')
  })

  it('a submitted-but-not-yet-synced sheet that turns out cancelled also gets the cancelled chip, not "sync error"', () => {
    // Operator tapped submit locally, then the batch-submit outcome came back CANCELLED
    // (supervisor cancelled it moments before the completion reached the server).
    const sheet = baseSheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'CANCELLED',
      syncError: SYNC_OUTCOME_MESSAGES.CANCELLED
    })

    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('لغو شده توسط سرپرست')
    expect(isHistoryLogSheet(sheet)).toBe(true)
  })

  it('synced completion still wins even if a stale CANCELLED flag lingers', () => {
    const sheet = baseSheet({
      status: 'submitted',
      syncStatus: 'synced',
      serverStatus: 'CANCELLED'
    })

    expect(resolveLocalLogSheetStatusChip(sheet).label).toBe('ارسال شده')
  })

  it('canSubmitLogSheet blocks a cancelled sheet with its own reason, not the expired one', () => {
    const sheet = baseSheet({ status: 'draft', serverStatus: 'CANCELLED', dueAt: Date.now() + 3_600_000 })

    const result = canSubmitLogSheet(sheet)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(SYNC_OUTCOME_MESSAGES.CANCELLED)
  })

  it('syncOutcomeMessage maps the CANCELLED outcome to its dedicated message', () => {
    expect(syncOutcomeMessage('CANCELLED')).toBe(SYNC_OUTCOME_MESSAGES.CANCELLED)
  })
})

describe('isSupersededSyncError (structural check, not text matching)', () => {
  // The server sends its OWN Persian translation of the failure reason (see
  // ApiResponseSupport.localize / ErrorTranslator.java), which is worded differently from this
  // client's SYNC_OUTCOME_MESSAGES constants. A real superseded sheet's syncError never equals
  // SYNC_OUTCOME_MESSAGES.SUPERSEDED verbatim — the structural signal must catch it anyway.
  const backendSupersededText = 'این لاگ‌شیت قبلاً توسط شخص دیگری تکمیل شده است.'

  it('recognizes a superseded sheet from status/syncStatus/serverStatus alone, ignoring syncError wording', () => {
    const sheet = baseSheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'SUBMITTED',
      syncError: backendSupersededText
    })

    expect(isSupersededSyncError(sheet)).toBe(true)
    expect(isInvalidLocalLogSheet(sheet)).toBe(true)
  })

  it('does not confuse a genuinely-synced-by-this-device sheet for a superseded one', () => {
    const sheet = baseSheet({ status: 'submitted', syncStatus: 'synced', serverStatus: 'SUBMITTED' })

    expect(isSupersededSyncError(sheet)).toBe(false)
  })

  it('does not flag a failed sheet whose server sheet is not SUBMITTED (e.g. genuinely cancelled)', () => {
    const sheet = baseSheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'CANCELLED',
      syncError: SYNC_OUTCOME_MESSAGES.CANCELLED
    })

    expect(isSupersededSyncError(sheet)).toBe(false)
  })

  it('still falls back to the exact-text match for a legacy/purely-local syncError', () => {
    const sheet = baseSheet({ status: 'submitted', syncStatus: 'failed', syncError: SYNC_OUTCOME_MESSAGES.SUPERSEDED })

    expect(isSupersededSyncError(sheet)).toBe(true)
  })

  it('a superseded sheet is correctly excluded from the active list, not just history', () => {
    // Regression guard: before the structural check, isInvalidLocalLogSheet silently never
    // matched a real backend-reported SUPERSEDED syncError, so isActiveLogSheet incorrectly
    // kept showing a superseded sheet as still active.
    const sheet = baseSheet({
      status: 'submitted',
      syncStatus: 'failed',
      serverStatus: 'SUBMITTED',
      syncError: backendSupersededText
    })

    expect(isActiveLogSheet(sheet)).toBe(false)
    expect(isHistoryLogSheet(sheet)).toBe(true)
  })
})
