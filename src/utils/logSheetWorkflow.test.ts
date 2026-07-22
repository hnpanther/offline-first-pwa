import { describe, expect, it } from 'vitest'
import {
  alignLocalWorkflowWithServer,
  shouldPreserveLocalFormData,
  revivalUpdatesAfterReassign
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

  it('resets submitted pending when assignee mismatch', () => {
    const local = baseLocal({
      status: 'submitted',
      syncStatus: 'pending',
      assigneeUserId: '1',
      localOwnerUserId: '1'
    })
    const server = baseServer({ assigneeUserId: 2, status: 'IN_PROGRESS' })

    expect(alignLocalWorkflowWithServer(local, server)).toBe('reset-draft')
  })

  it('marks synced when server is SUBMITTED', () => {
    const local = baseLocal({ status: 'submitted', syncStatus: 'pending' })
    const server = baseServer({ status: 'SUBMITTED' })

    expect(alignLocalWorkflowWithServer(local, server)).toBe('mark-synced')
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
