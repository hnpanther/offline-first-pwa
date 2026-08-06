import type { LogSheet } from '@/types'
import { resolveLocalWorkOwner } from '@/utils/logSheetLocalData'

/**
 * Dashboard counters, scoped to whoever is looking at them.
 *
 * The device's `logSheets` table is shared: on a tablet that several operators
 * sign into, it holds everyone's work. Counting all of it showed each user the
 * device's totals rather than their own.
 *
 * The rule is deliberately narrow — **your own work only** — and that includes
 * supervisors: a supervisor's dashboard reports what they personally have open,
 * not their team's. Team work is what the inbox's team tab is for. Only ADMIN /
 * HIGH_USER see the device-wide totals, as an operational overview of the tablet.
 *
 * With no resolved `sessionUserId` a non-admin sees zeros rather than the
 * device's numbers. That is the honest answer: local sheets arrive from the
 * server already attributed, so a user whose id could not be resolved genuinely
 * has no attributable work here.
 */

export interface DashboardScope {
  sessionUserId: string | null
  isAdmin: boolean
}

export interface DashboardStats {
  open: number
  submittedToday: number
  synced: number
}

export function scopeSheetsToViewer(sheets: LogSheet[], scope: DashboardScope): LogSheet[] {
  if (scope.isAdmin) return sheets
  if (!scope.sessionUserId) return []
  return sheets.filter(s => resolveLocalWorkOwner(s) === scope.sessionUserId)
}

/** Start of the local day, used as the "submitted today" cutoff. */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function computeDashboardStats(
  sheets: LogSheet[],
  scope: DashboardScope,
  now = Date.now()
): DashboardStats {
  const mine = scopeSheetsToViewer(sheets, scope)
  const dayStart = startOfLocalDay(now)
  return {
    open: mine.filter(s => s.status === 'draft').length,
    submittedToday: mine.filter(s => (s.submittedAt ?? 0) >= dayStart).length,
    synced: mine.filter(s => s.syncStatus === 'synced').length
  }
}
