import { describe, expect, it } from 'vitest'
import { archivedLogSheetViewId } from '@/services/storage/logSheetArchive'
import {
  isHistoryLogSheet,
  isActiveLogSheet,
  resolveLocalLogSheetStatusChip,
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
