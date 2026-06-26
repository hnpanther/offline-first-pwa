/**
 * SyncManager — handles all outbound data synchronization.
 *
 * Responsibilities:
 *  1. Push approved DataRecords to /api/records/batch
 *  2. Push submitted LogSheets to /api/log-sheets/batch
 *  3. Retry failed items on reconnect or on schedule
 *  4. Emit events for the UI (SyncStatusBar, useSync hook)
 *
 * NOT responsible for:
 *  - Pulling master data from the server (→ pullMasterData.ts)
 *  - Outbox-based entity sync (→ future push.ts)
 */

import {
  getPendingRecords,
  updateRecordSyncStatus,
  getPendingCount,
  getAllLogSheets,
  updateLogSheet,
} from '@/services/storage'
import { submitRecordsBatch, submitLogSheetsBatch } from '@/services/api'
import type { DataRecord, LogSheet } from '@/types'

export type SyncEventType = 'start' | 'progress' | 'complete' | 'error'

export interface SyncEvent {
  type: SyncEventType
  pendingCount?: number
  syncedCount?: number
  failedCount?: number
  error?: string
}

type SyncListener = (event: SyncEvent) => void

class SyncManager {
  private listeners: Set<SyncListener> = new Set()
  private isSyncing = false
  private intervalId: ReturnType<typeof setInterval> | null = null
  private intervalMs = 30_000
  private abortController: AbortController | null = null

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Pub/sub
  // -------------------------------------------------------------------------

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: SyncEvent): void {
    this.listeners.forEach(fn => fn(event))
  }

  // -------------------------------------------------------------------------
  // Sync — records + log sheets
  // -------------------------------------------------------------------------

  async sync(): Promise<void> {
    if (this.isSyncing || !navigator.onLine) return

    const [pendingRecords, pendingLogSheets] = await Promise.all([
      getPendingRecords(),
      this.getPendingLogSheets(),
    ])

    const totalPending = pendingRecords.length + pendingLogSheets.length
    if (totalPending === 0) return

    this.isSyncing = true
    this.abortController = new AbortController()
    this.emit({ type: 'start', pendingCount: totalPending })

    let syncedCount = 0
    let failedCount = 0

    try {
      // --- 1. Push DataRecords ---
      if (pendingRecords.length > 0) {
        await Promise.all(
          pendingRecords.map(r => updateRecordSyncStatus(r.localId, 'syncing'))
        )

        const recordResults = await submitRecordsBatch(pendingRecords, this.abortController.signal)

        for (const result of recordResults) {
          const record = pendingRecords.find((r: DataRecord) => r.localId === result.localId)
          if (!record) continue

          if (result.serverId) {
            await updateRecordSyncStatus(record.localId, 'synced', {
              serverId: result.serverId,
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

      // --- 2. Push LogSheets ---
      if (pendingLogSheets.length > 0) {
        // Mark as syncing (re-use syncStatus field on LogSheet)
        await Promise.all(
          pendingLogSheets.map(ls =>
            updateLogSheet(ls.localId, { syncStatus: 'syncing' as const })
          )
        )

        const lsResults = await submitLogSheetsBatch(pendingLogSheets, this.abortController.signal)

        for (const result of lsResults) {
          const ls = pendingLogSheets.find((l: LogSheet) => l.localId === result.localId)
          if (!ls) continue

          if (result.serverId) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'synced',
              syncedAt: Date.now(),
              serverId: result.serverId,
            })
            syncedCount++
          } else {
            await updateLogSheet(ls.localId, {
              syncStatus: 'failed',
              syncError: result.error ?? 'خطای ناشناخته',
            })
            failedCount++
          }
        }
      }

      this.emit({ type: 'complete', syncedCount, failedCount })
    } catch (err) {
      // On network error: revert all to 'failed' so they retry next cycle
      await Promise.all([
        ...pendingRecords.map(r =>
          updateRecordSyncStatus(r.localId, 'failed', {
            syncError: err instanceof Error ? err.message : 'خطا در ارتباط با سرور',
          })
        ),
        ...pendingLogSheets.map(ls =>
          updateLogSheet(ls.localId, {
            syncStatus: 'failed',
            syncError: err instanceof Error ? err.message : 'خطا در ارتباط با سرور',
          })
        ),
      ])

      failedCount = totalPending
      this.emit({
        type: 'error',
        failedCount,
        error: err instanceof Error ? err.message : 'خطا در همگام‌سازی',
      })
    } finally {
      this.isSyncing = false
      this.abortController = null
    }
  }

  async getPendingCount(): Promise<number> {
    const [records, logSheets] = await Promise.all([
      getPendingCount(),
      this.getPendingLogSheets(),
    ])
    return records + logSheets.length
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Submitted log sheets that haven't been synced yet */
  private async getPendingLogSheets(): Promise<LogSheet[]> {
    const all = await getAllLogSheets()
    return all.filter(
      ls => ls.status === 'submitted' && ls.syncStatus !== 'synced'
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
