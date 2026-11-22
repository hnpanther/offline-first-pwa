/**
 * Sends the panel this tablet's count of undelivered rounds (backend V25, `POST /api/sync/backlog`).
 *
 * Only when it has changed, or an hour after the last report — a sync pass runs every 30 seconds,
 * and the panel needs to know when a tablet starts holding work nobody has seen, not to be told
 * the same number 120 times an hour. The last report is kept in `syncMeta`, so an app restart
 * does not resend an unchanged number.
 *
 * A failure (offline, an older server without the endpoint) changes nothing and is retried on a
 * later pass; the caller swallows it.
 */

import { db } from '@/services/storage/db'
import { getAllLogSheets } from '@/services/storage'
import { getAuthSession } from '@/services/auth'
import { reportSyncBacklog } from '@/services/api'
import { computeUndeliveredBacklog, type UndeliveredBacklog } from '@/services/sync/undelivered'
import type { LogSheet } from '@/types'
import { serverNow } from '@/services/clock/serverClock'

const META_KEY = 'lastBacklogReport'
const RESEND_AFTER_MS = 60 * 60 * 1000

interface StoredReport {
  count: number
  oldestAt: number | null
  at: number
  /**
   * Which session the report went to. The server writes it onto the **session's** row, so a
   * tablet signed into by another operator — or the same one again — is a new row that has
   * heard nothing yet. Found live: operator 2 signed in on a tablet whose count was still 0
   * from operator 1, nothing was sent, and the panel showed «گزارش نشده» for their session.
   */
  session?: string
}

/** Identifies the signed-in session without storing any part of its token. */
async function currentSessionKey(): Promise<string | null> {
  const session = await getAuthSession()
  return session ? `${session.username}:${session.expiresAt}` : null
}

async function lastReport(): Promise<StoredReport | null> {
  const row = await db.syncMeta.get(META_KEY)
  const value = row?.value as StoredReport | undefined
  return value && typeof value.count === 'number' && typeof value.at === 'number' ? value : null
}

export async function currentUndeliveredBacklog(now = Date.now()): Promise<UndeliveredBacklog> {
  return computeUndeliveredBacklog(await getAllLogSheets(), serverNow(now))
}

/**
 * @param sheets every local round, when the caller has just read them — the sync pass reads the
 *        table once and hands the purge's survivors on (issue P-08). Read here when absent.
 * @returns whether a report was sent.
 */
export async function reportUndeliveredBacklogIfChanged(
  signal?: AbortSignal,
  now = Date.now(),
  sheets?: LogSheet[]
): Promise<boolean> {
  const sessionKey = await currentSessionKey()
  if (!sessionKey) return false
  const backlog = sheets
    ? computeUndeliveredBacklog(sheets, serverNow(now))
    : await currentUndeliveredBacklog(now)
  const previous = await lastReport()
  const unchanged =
    previous != null &&
    previous.session === sessionKey &&
    previous.count === backlog.count &&
    previous.oldestAt === backlog.oldestAt &&
    now - previous.at < RESEND_AFTER_MS
  if (unchanged) return false

  await reportSyncBacklog(
    { undeliveredCount: backlog.count, oldestUndeliveredAt: backlog.oldestAt },
    signal
  )
  await db.syncMeta.put({
    key: META_KEY,
    value: {
      count: backlog.count,
      oldestAt: backlog.oldestAt,
      at: now,
      session: sessionKey
    } satisfies StoredReport
  })
  return true
}
