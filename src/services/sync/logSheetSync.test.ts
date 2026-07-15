import { describe, expect, it } from 'vitest'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import type { LogSheet } from '@/types'

describe('toBatchPayload', () => {
  it('includes entry createdAt and updatedAt in batch payload', () => {
    const sheet: LogSheet = {
      id: 'local-1',
      localId: 'local-1',
      serverId: '99',
      templateId: '5',
      templateName: 'Daily',
      scopeSummary: 'loc:1',
      status: 'submitted',
      syncStatus: 'pending',
      clientActionId: 'action-1',
      completedAt: 1_700_000_200_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_200_000,
      entries: [
        {
          assetId: '42',
          assetName: 'Pump',
          subFunctionCode: 'SF',
          subFunctionTag: 'T',
          classId: '7',
          formData: { temp: 22 },
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000
        }
      ]
    }

    const payload = toBatchPayload(sheet)

    expect(payload.entries).toHaveLength(1)
    expect(payload.entries?.[0].createdAt).toBe(1_700_000_000_000)
    expect(payload.entries?.[0].updatedAt).toBe(1_700_000_100_000)
  })

  it('omits entry timestamps when not set locally', () => {
    const sheet: LogSheet = {
      id: 'local-2',
      localId: 'local-2',
      serverId: '100',
      templateId: '5',
      templateName: 'Daily',
      scopeSummary: 'loc:1',
      status: 'submitted',
      syncStatus: 'pending',
      clientActionId: 'action-2',
      completedAt: 1_700_000_200_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_200_000,
      entries: [
        {
          assetId: '42',
          assetName: 'Pump',
          subFunctionCode: 'SF',
          subFunctionTag: 'T',
          classId: '7',
          formData: {}
        }
      ]
    }

    const payload = toBatchPayload(sheet)

    expect(payload.entries?.[0].createdAt).toBeUndefined()
    expect(payload.entries?.[0].updatedAt).toBeUndefined()
  })
})
