import { describe, it, expect } from 'vitest'
import { shouldPreserveLocalFormData } from '@/utils/logSheetWorkflow'
import { isLogSheetOutboundOwnedByUser } from '@/services/auth/sessionContext'
import type { LogSheet } from '@/types'
import type { ServerLogSheet } from '@/services/api'

/**
 * Why sync and inbox merge must halt while `sessionUserId` is unresolved.
 *
 * These two predicates are the reason. Both answer "does this session own this work?", and
 * both answer **no** for a null session — correctly, since an unnamed session owns nothing.
 * The consequences are opposite in character, which is what made the original bug so easy to
 * miss: one fails silently and harmlessly, the other silently destroys data.
 *
 * If either of these ever starts returning true for a null id, the gating in
 * `SyncManager.executeSync` and `pullAndMergeInbox` becomes unnecessary — and, more likely,
 * something has broken. These tests are that tripwire.
 */

const OWNER = '7'

function localSheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    localId: 'l1',
    serverId: '99',
    templateName: 'روزانه',
    scopeSummary: 'scope',
    status: 'submitted',
    syncStatus: 'pending',
    assigneeUserId: OWNER,
    entries: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as LogSheet
}

function serverSheet(overrides: Partial<ServerLogSheet> = {}): ServerLogSheet {
  return { id: 99, assigneeUserId: Number(OWNER), ...overrides } as ServerLogSheet
}

describe('outbound sync ownership', () => {
  it('refuses to push anything when the session has no user id', () => {
    // Harmless in itself — but it means a device can look perfectly healthy while sending
    // nothing at all, which is exactly what went unnoticed before the banner existed.
    expect(isLogSheetOutboundOwnedByUser(localSheet(), null)).toBe(false)
  })

  it('pushes the owner’s own submitted work once the id is known', () => {
    expect(isLogSheetOutboundOwnedByUser(localSheet(), OWNER)).toBe(true)
  })

  it('still refuses work belonging to a different assignee', () => {
    expect(isLogSheetOutboundOwnedByUser(localSheet({ assigneeUserId: '8' }), OWNER)).toBe(false)
  })
})

describe('local form-data preservation on inbox merge', () => {
  it('refuses to protect local values when the session has no user id', () => {
    // This is the destructive half: merging in this state treats the operator's own typed
    // values as somebody else's and lets the server's empty entries overwrite them. Hence
    // pullAndMergeInbox skips the merge outright rather than calling it unbound.
    expect(shouldPreserveLocalFormData(localSheet(), serverSheet(), null)).toBe(false)
  })

  it('protects the owner’s values once the id is known', () => {
    expect(shouldPreserveLocalFormData(localSheet(), serverSheet(), OWNER)).toBe(true)
  })

  it('does not protect values the server has reassigned to someone else', () => {
    expect(shouldPreserveLocalFormData(localSheet(), serverSheet({ assigneeUserId: 8 }), OWNER))
      .toBe(false)
  })
})
