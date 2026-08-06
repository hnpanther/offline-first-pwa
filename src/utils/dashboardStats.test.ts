import { describe, it, expect } from 'vitest'
import { computeDashboardStats, scopeSheetsToViewer, startOfLocalDay } from './dashboardStats'
import type { LogSheet } from '@/types'

const NOW = new Date('2026-08-06T14:00:00').getTime()
const TODAY = startOfLocalDay(NOW) + 60_000
const YESTERDAY = startOfLocalDay(NOW) - 60_000

function sheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    localId: 'l1',
    templateName: 'T',
    scopeSummary: 'S',
    status: 'draft',
    syncStatus: 'pending',
    entries: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

// A shared tablet: two operators plus one sheet with no owner at all.
const device = [
  sheet({ localId: 'a1', assigneeUserId: '7', status: 'draft' }),
  sheet({ localId: 'a2', assigneeUserId: '7', status: 'submitted', submittedAt: TODAY, syncStatus: 'synced' }),
  sheet({ localId: 'a3', assigneeUserId: '7', status: 'submitted', submittedAt: YESTERDAY, syncStatus: 'synced' }),
  sheet({ localId: 'b1', assigneeUserId: '9', status: 'draft' }),
  sheet({ localId: 'b2', assigneeUserId: '9', status: 'submitted', submittedAt: TODAY, syncStatus: 'synced' }),
  sheet({ localId: 'x1', assigneeUserId: undefined, status: 'draft' })
]

describe('scopeSheetsToViewer', () => {
  it('gives a regular user only their own sheets', () => {
    const mine = scopeSheetsToViewer(device, { sessionUserId: '7', isAdmin: false })
    expect(mine.map(s => s.localId)).toEqual(['a1', 'a2', 'a3'])
  })

  it('gives a supervisor their own sheets too — not the whole device', () => {
    // Supervisors are not admins here; their team's work belongs in the inbox tab.
    const mine = scopeSheetsToViewer(device, { sessionUserId: '9', isAdmin: false })
    expect(mine.map(s => s.localId)).toEqual(['b1', 'b2'])
  })

  it('gives an admin every sheet on the device', () => {
    const all = scopeSheetsToViewer(device, { sessionUserId: '7', isAdmin: true })
    expect(all).toHaveLength(device.length)
  })

  it('returns nothing for a non-admin whose user id is unresolved', () => {
    expect(scopeSheetsToViewer(device, { sessionUserId: null, isAdmin: false })).toEqual([])
  })

  it('still shows everything to an admin with an unresolved user id', () => {
    expect(scopeSheetsToViewer(device, { sessionUserId: null, isAdmin: true })).toHaveLength(6)
  })

  it('prefers localOwnerUserId over assigneeUserId when the sheet was reassigned', () => {
    const reassigned = [sheet({ localId: 'r1', assigneeUserId: '9', localOwnerUserId: '7' })]
    expect(scopeSheetsToViewer(reassigned, { sessionUserId: '7', isAdmin: false })).toHaveLength(1)
    expect(scopeSheetsToViewer(reassigned, { sessionUserId: '9', isAdmin: false })).toHaveLength(0)
  })
})

describe('computeDashboardStats', () => {
  it('counts only the viewer’s own open / today / synced sheets', () => {
    expect(computeDashboardStats(device, { sessionUserId: '7', isAdmin: false }, NOW)).toEqual({
      open: 1,
      submittedToday: 1,
      synced: 2
    })
  })

  it('counts the whole device for an admin', () => {
    expect(computeDashboardStats(device, { sessionUserId: '1', isAdmin: true }, NOW)).toEqual({
      open: 3,
      submittedToday: 2,
      synced: 3
    })
  })

  it('excludes work submitted before midnight from the today count', () => {
    const onlyYesterday = [
      sheet({ assigneeUserId: '7', status: 'submitted', submittedAt: YESTERDAY })
    ]
    expect(
      computeDashboardStats(onlyYesterday, { sessionUserId: '7', isAdmin: false }, NOW).submittedToday
    ).toBe(0)
  })

  it('is all zeros when the viewer has no work on this device', () => {
    expect(computeDashboardStats(device, { sessionUserId: '404', isAdmin: false }, NOW)).toEqual({
      open: 0,
      submittedToday: 0,
      synced: 0
    })
  })
})
