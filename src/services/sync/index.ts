/**
 * SyncManager — handles all outbound data synchronization.
 */

import {
  getPendingRecords,
  updateRecordSyncStatus,
  getPendingCount,
  getAllLogSheets,
  updateLogSheet,
} from '@/services/storage'
import { submitRecordsBatch, submitLogSheetsBatch } from '@/services/api'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import { getAuthSession } from '@/services/auth'
import { getSessionUserId, isLogSheetOutboundOwnedByUser } from '@/services/auth/sessionContext'
import { hasPermission } from '@/types/auth'
import {
  isLogSheetExpiredForSync,
  isOwnershipReassignError,
  normalizeLogSheetSyncError,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { DataRecord, LogSheet } from '@/types'
import { toIdString } from '@/utils/ids'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'

export type SyncEventType = 'start' | 'progress' | 'complete' | 'error'

export interface SyncEvent {
  type: SyncEventType
  pendingCount?: number
  syncedCount?: number
  failedCount?: number
  error?: string
  /** Transient network failure — UI should not flash error state */
  transient?: boolean
}

type SyncListener = (event: SyncEvent) => void

class SyncManager {
  private listeners: Set<SyncListener> = new Set()
  private isSyncing = false
  private syncInFlight: Promise<void> | null = null
  private intervalId: ReturnType<typeof setInterval> | null = null
  private intervalMs = 30_000
  private abortController: AbortController | null = null

  start(intervalMs?: number): void {
    if (intervalMs) this.intervalMs = intervalMs
    this.setupOnlineListener()
    this.scheduleInterval()
    void this.sync()
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.abortController?.abort()
    window.removeEventListener('online', this.handleOnline)
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: SyncEvent): void {
    this.listeners.forEach(fn => fn(event))
  }

  private async refreshPendingCount(): Promise<number> {
    const count = await this.getPendingCount()
    this.emit({ type: 'progress', pendingCount: count })
    return count
  }

  async sync(): Promise<void> {
    if (!navigator.onLine) return
    if (this.syncInFlight) return this.syncInFlight

    this.syncInFlight = this.executeSync().finally(() => {
      this.syncInFlight = null
    })
    return this.syncInFlight
  }

  private async executeSync(): Promise<void> {
    if (this.isSyncing) return

    const session = await getAuthSession()
    if (!session) return

    await this.markExpiredSheets()

    const canSyncRecords = hasPermission(session, 'POST:/api/records/batch')

    const [pendingRecords, pendingLogSheets] = await Promise.all([
      canSyncRecords ? getPendingRecords() : Promise.resolve([]),
      this.getPendingLogSheets(),
    ])

    const totalPending = pendingRecords.length + pendingLogSheets.length
    if (totalPending === 0) {
      await this.refreshPendingCount()
      return
    }

    this.isSyncing = true
    this.abortController = new AbortController()
    this.emit({ type: 'start', pendingCount: totalPending })

    let syncedCount = 0
    let failedCount = 0

    try {
      if (pendingRecords.length > 0) {
        const recordResults = await submitRecordsBatch(
          pendingRecords,
          this.abortController.signal
        )

        for (const result of recordResults) {
          const record = pendingRecords.find((r: DataRecord) => r.localId === result.localId)
          if (!record) continue

          if (result.serverId) {
            await updateRecordSyncStatus(record.localId, 'synced', {
              serverId: toIdString(result.serverId),
              syncedAt: Date.now(),
            })
            syncedCount++
          } else {
            await updateRecordSyncStatus(record.localId, 'failed', {
              syncError: result.error ?? 'خطای ناشناخته',
            })
            failedCount++
          }
        }
      }

      if (pendingLogSheets.length > 0) {
        const payloads = pendingLogSheets.map(ls => toBatchPayload(ls))
        const lsResults = await submitLogSheetsBatch(
          payloads,
          this.abortController.signal
        )

        for (const result of lsResults) {
          const ls = pendingLogSheets.find((l: LogSheet) => l.localId === result.localId)
          if (!ls) continue

          if (result.outcome === 'SUBMITTED') {
            await updateLogSheet(ls.localId, {
              syncStatus: 'synced',
              syncedAt: Date.now(),
              serverId: toIdString(result.serverId ?? ls.serverId),
              serverStatus: 'SUBMITTED',
              syncError: undefined
            })
            syncedCount++
            continue
          }

          if (result.outcome === 'DUPLICATE' && result.serverId) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'synced',
              syncedAt: Date.now(),
              serverId: toIdString(result.serverId),
              serverStatus: 'SUBMITTED',
              syncError: undefined
            })
            syncedCount++
            continue
          }

          const syncError = normalizeLogSheetSyncError(result.outcome, result.error)

          if (isOwnershipReassignError(syncError)) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'failed',
              syncError,
            })
            failedCount++
            continue
          }

          await updateLogSheet(ls.localId, {
            syncStatus: 'failed',
            syncError,
            serverStatus:
              result.outcome === 'EXPIRED'
                ? 'EXPIRED'
                : result.outcome === 'SUPERSEDED'
                ? 'SUBMITTED'
                : ls.serverStatus
          })
          failedCount++
        }
      }

      const remaining = await this.refreshPendingCount()
      await cleanupLocalLogSheets()
      this.emit({ type: 'complete', syncedCount, failedCount, pendingCount: remaining })
    } catch (err) {
      // Transient network error — keep items pending, avoid UI flash
      this.emit({
        type: 'error',
        failedCount: 0,
        transient: true,
        error: err instanceof Error ? err.message : 'خطا در ارتباط با سرور',
      })
      await this.refreshPendingCount()
    } finally {
      this.isSyncing = false
      this.abortController = null
    }
  }

  private async markExpiredSheets(): Promise<void> {
    const all = await getAllLogSheets()
    for (const ls of all) {
      if (ls.status !== 'submitted' || ls.syncStatus === 'synced') continue
      if (!isLogSheetExpiredForSync(ls)) continue
      await updateLogSheet(ls.localId, {
        syncStatus: 'failed',
        syncError: SYNC_OUTCOME_MESSAGES.EXPIRED,
        serverStatus: 'EXPIRED'
      })
    }
  }

  async getPendingCount(): Promise<number> {
    const session = await getAuthSession()
    const canSyncRecords = session
      ? hasPermission(session, 'POST:/api/records/batch')
      : false
    const [records, logSheets] = await Promise.all([
      canSyncRecords ? getPendingCount() : Promise.resolve(0),
      this.getPendingLogSheets(),
    ])
    return records + logSheets.length
  }

  private async getPendingLogSheets(): Promise<LogSheet[]> {
    const userId = await getSessionUserId()
    const all = await getAllLogSheets()
    return all.filter(
      ls =>
        isLogSheetOutboundOwnedByUser(ls, userId) &&
        ls.serverId &&
        !isLogSheetExpiredForSync(ls)
    )
  }

  private handleOnline = (): void => {
    void this.sync()
  }

  private setupOnlineListener(): void {
    window.addEventListener('online', this.handleOnline)
  }

  private scheduleInterval(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId)
    this.intervalId = setInterval(() => void this.sync(), this.intervalMs)
  }
}

export const syncManager = new SyncManager()
