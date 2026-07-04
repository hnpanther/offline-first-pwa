import { fetchLogSheetInbox } from '@/services/api'
import type { ServerLogSheet } from '@/services/api'

export interface InboxState {
  assigned: ServerLogSheet[]
  available: ServerLogSheet[]
  serverTime: number | null
  lastSyncAt: number | null
  error: string | null
  loading: boolean
}

export async function pullInbox(signal?: AbortSignal): Promise<{
  assigned: ServerLogSheet[]
  available: ServerLogSheet[]
  serverTime: number
}> {
  const response = await fetchLogSheetInbox(signal)
  return {
    assigned: response.assigned ?? [],
    available: response.available ?? [],
    serverTime: response.serverTime
  }
}
