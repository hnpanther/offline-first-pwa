import { fetchLogSheetInbox } from '@/services/api'
import type { LogSheetBundleDto, ServerLogSheet } from '@/services/api'

export interface InboxPullResult {
  assigned: LogSheetBundleDto[]
  assignedSheets: ServerLogSheet[]
  available: ServerLogSheet[]
  teamOpen: ServerLogSheet[]
  serverTime: number
}

export async function pullInbox(signal?: AbortSignal): Promise<InboxPullResult> {
  const response = await fetchLogSheetInbox(signal)
  const assigned = response.assigned ?? []
  return {
    assigned,
    assignedSheets: assigned.map(b => b.sheet),
    available: response.available ?? [],
    teamOpen: response.teamOpen ?? [],
    serverTime: response.serverTime
  }
}
