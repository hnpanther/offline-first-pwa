import {
  getPendingRecords,
  updateRecordSyncStatus,
  getPendingCount
} from '@/services/storage'
import { submitRecordsBatch } from '@/services/api'
import type { DataRecord } from '@/types'

export type SyncEventType = 'start' | 'progress' | 'complete' | 'error'

export interface SyncEvent {
  type: SyncEventType
  pendingCount?: number
  syncedCount?: number
  failedCount?: number
  error?: string
}

type SyncListener = (event: SyncEvent) => void

/**
 * SyncManager handles all background synchronization.
 * - Watches for online/offline changes
 * - Periodically retries pending records
 * - Emits events so the UI can show sync status
 */
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
    // Try immediately on start
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
  // Listeners (pub/sub for React hooks)
  // -------------------------------------------------------------------------

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: SyncEvent): void {
    this.listeners.forEach(fn => fn(event))
  }

  // -------------------------------------------------------------------------
  // Sync logic
  // -------------------------------------------------------------------------

  async sync(): Promise<void> {
    if (this.isSyncing || !navigator.onLine) return

    const pending = await getPendingRecords()
    if (pending.length === 0) return

    this.isSyncing = true
    this.abortController = new AbortController()
    this.emit({ type: 'start', pendingCount: pending.length })

    // Mark all as "syncing" so the UI shows correct state
    await Promise.all(
      pending.map(r => updateRecordSyncStatus(r.localId, 'syncing'))
    )

    let syncedCount = 0
    let failedCount = 0

    try {
      const results = await submitRecordsBatch(pending, this.abortController.signal)

      for (const result of results) {
        const record = pending.find((r: DataRecord) => r.localId === result.localId)
        if (!record) continue

        if (result.serverId) {
          await updateRecordSyncStatus(record.localId, 'synced', {
            serverId: result.serverId,
            syncedAt: Date.now()
          })
          syncedCount++
        } else {
          await updateRecordSyncStatus(record.localId, 'failed', {
            syncError: result.error ?? 'خطای ناشناخته'
          })
          failedCount++
        }
      }

      this.emit({ type: 'complete', syncedCount, failedCount })
    } catch (err) {
      // Revert all to "failed" so they retry next cycle
      await Promise.all(
        pending.map(r =>
          updateRecordSyncStatus(r.localId, 'failed', {
            syncError: err instanceof Error ? err.message : 'خطا در ارتباط با سرور'
          })
        )
      )
      failedCount = pending.length
      const errorMsg = err instanceof Error ? err.message : 'خطا در همگام‌سازی'
      this.emit({ type: 'error', failedCount, error: errorMsg })
    } finally {
      this.isSyncing = false
      this.abortController = null
    }
  }

  async getPendingCount(): Promise<number> {
    return getPendingCount()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleOnline = (): void => {
    void this.sync()
  }

  private setupOnlineListener(): void {
    window.addEventListener('online', this.handleOnline)
  }

  private scheduleInterval(): void {
    if (this.intervalId !== null) clearInterval(this.intervalId)
    this.intervalId = setInterval(() => {
      void this.sync()
    }, this.intervalMs)
  }
}

// Singleton — import and use anywhere
export const syncManager = new SyncManager()
