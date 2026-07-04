import { db } from '@/services/storage/db'
import type { ServerLogSheet } from '@/services/api'

export interface InboxSnapshot {
  assigned: ServerLogSheet[]
  available: ServerLogSheet[]
  teamOpen: ServerLogSheet[]
  lastSyncAt: number
  serverTime: number
}

const INBOX_KEY = 'inboxSnapshot'

export async function saveInboxSnapshot(snapshot: InboxSnapshot): Promise<void> {
  await db.syncMeta.put({ key: INBOX_KEY, value: snapshot })
}

export async function loadInboxSnapshot(): Promise<InboxSnapshot | null> {
  const row = await db.syncMeta.get(INBOX_KEY)
  if (!row?.value || typeof row.value !== 'object') return null
  return row.value as InboxSnapshot
}

export async function clearInboxSnapshot(): Promise<void> {
  await db.syncMeta.delete(INBOX_KEY)
}
