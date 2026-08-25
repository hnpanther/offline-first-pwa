/**
 * SyncManager — handles all outbound data synchronization.
 */

import {
  getAllLogSheets,
  updateLogSheet,
} from '@/services/storage'
import {
  getPendingNfcFaultReports,
  updateNfcFaultReportSyncStatus
} from '@/services/storage/nfcFaultReports'
import { submitLogSheetsBatch, submitNfcFaultReportsBatch } from '@/services/api'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import { getOwnPendingAttachments, syncPendingAttachments } from '@/services/sync/attachmentSync'
import { pushPendingLogSheetProgress } from '@/services/sync/progressSync'
import { bindAttachmentsToServerSheet } from '@/services/storage/attachments'
import { getAuthSession } from '@/services/auth'
import {
  ensureSessionUserId,
  getSessionUserId,
  isLogSheetOutboundOwnedByUser
} from '@/services/auth/sessionContext'
import {
  removeArchivedLogSheet,
  getArchivedSubmissionsPendingServerOutcome,
  updateArchivedLogSheetSnapshot,
  parseArchivedLogSheetViewId
} from '@/services/storage/logSheetArchive'
import { hasPermission, PERM_LOG_SHEET_PROGRESS, PERM_NFC_FAULT_REPORT } from '@/types/auth'
import {
  isLogSheetExpiredForSync,
  isOwnershipReassignError,
  normalizeLogSheetSyncError,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { LogSheet, NfcFaultReport } from '@/types'
import { toIdString } from '@/utils/ids'
import { clearLocalEditMarkers } from '@/utils/logSheetLocalData'
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

    // Retry the binding first — this is the main place it heals, because sync ticks on a
    // timer and on every reconnect. Without an id nothing below can be attributed: the
    // outbound queue would come back empty anyway, so returning here is the same outcome
    // stated honestly, and it keeps a zero pending badge from reading as "all sent".
    const sessionUserId = await ensureSessionUserId()
    if (!sessionUserId) return

    await this.markExpiredSheets()

    // Before the submit batch, and outside its try/catch. A round being walked reports its
    // progress so a supervisor can see how far it has got; that report is best-effort by
    // definition, and it must never be able to fail — or be failed by — the delivery of work
    // the operator has actually finished.
    //
    // Gated on the permission for the same reason fault reports are: pushing items the server
    // will refuse leaves a queue that never drains. It is its own permission on the server, so
    // holding POST:/api/log-sheets/batch does not imply it.
    if (hasPermission(session, PERM_LOG_SHEET_PROGRESS)) {
      await this.pushProgress()
    }

    const canSyncFaultReports = hasPermission(session, PERM_NFC_FAULT_REPORT)

    const [pendingLogSheets, pendingFaultReports] = await Promise.all([
      this.getPendingLogSheets(),
      canSyncFaultReports ? this.getPendingFaultReports() : Promise.resolve([]),
    ])

    const totalPending = pendingLogSheets.length + pendingFaultReports.length
    if (totalPending === 0) {
      // Nothing to submit — but attachments queue independently of sheets, and a sheet that
      // synced on an earlier pass can still be waiting on its photos.
      await this.syncAttachments()
      await this.refreshPendingCount()
      return
    }

    this.isSyncing = true
    this.abortController = new AbortController()
    this.emit({ type: 'start', pendingCount: totalPending })

    let syncedCount = 0
    let failedCount = 0

    try {
      if (pendingLogSheets.length > 0) {
        const payloads = pendingLogSheets.map(ls => toBatchPayload(ls))
        const lsResults = await submitLogSheetsBatch(
          payloads,
          this.abortController.signal
        )

        // Indexed once rather than scanned per result: the batch cap is 500
        // (app.sync.batch-max-items), so a linear find inside the loop is 250,000 comparisons
        // in the worst case, on the main thread of a tablet that is also rendering. Cheap to
        // do correctly and it removes the cap as something anyone has to think about.
        const pendingByLocalId = new Map(pendingLogSheets.map(l => [l.localId, l]))

        for (const result of lsResults) {
          const ls = pendingByLocalId.get(result.localId)
          if (!ls) continue

          const archivedRef = parseArchivedLogSheetViewId(ls.localId)
          if (archivedRef) {
            const accepted = result.outcome === 'SUBMITTED' || result.outcome === 'DUPLICATE'
            await this.applyArchivedLogSheetOutcome(
              archivedRef,
              result.outcome,
              accepted ? undefined : normalizeLogSheetSyncError(result.outcome, result.error)
            )
            if (accepted) syncedCount++
            else failedCount++
            continue
          }

          if (result.outcome === 'SUBMITTED') {
            await updateLogSheet(ls.localId, {
              syncStatus: 'synced',
              syncedAt: Date.now(),
              serverId: toIdString(result.serverId ?? ls.serverId),
              serverStatus: 'SUBMITTED',
              syncError: undefined,
              lastSubmitOutcome: undefined,
              // The work is the server's now, so this device stops claiming an opinion of its
              // own about these entries. Leaving the markers would make it win every later
              // merge for them — including after a supervisor reopens the sheet and edits it.
              entries: clearLocalEditMarkers(ls.entries),
              // Delivered work needs no progress report. The queue would skip this row anyway
              // (it only takes drafts, and the markers above are gone), so this is tidiness
              // rather than a guard — but a stale «pending» on a completed round reads as
              // something still outstanding.
              progressSyncStatus: undefined,
              progressError: undefined
            })
            const ownerId = await getSessionUserId()
            const serverId = toIdString(result.serverId ?? ls.serverId)
            // The sheet now exists on the server, so its attachments finally have somewhere
            // to go. Until this stamp lands the upload queue skips them by design.
            if (serverId) {
              await bindAttachmentsToServerSheet(ls.localId, serverId)
            }
            if (ownerId && serverId) {
              await removeArchivedLogSheet(serverId, ownerId)
            }
            syncedCount++
            continue
          }

          if (result.outcome === 'DUPLICATE' && result.serverId) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'synced',
              syncedAt: Date.now(),
              // Same as SUBMITTED: the server already holds this work.
              entries: clearLocalEditMarkers(ls.entries),
              serverId: toIdString(result.serverId),
              serverStatus: 'SUBMITTED',
              syncError: undefined,
              lastSubmitOutcome: undefined
            })
            await bindAttachmentsToServerSheet(ls.localId, toIdString(result.serverId))
            const ownerId = await getSessionUserId()
            if (ownerId) {
              await removeArchivedLogSheet(toIdString(result.serverId), ownerId)
            }
            syncedCount++
            continue
          }

          const syncError = normalizeLogSheetSyncError(result.outcome, result.error)

          if (isOwnershipReassignError(syncError)) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'failed',
              syncError,
              lastSubmitOutcome: result.outcome,
            })
            failedCount++
            continue
          }

          await updateLogSheet(ls.localId, {
            syncStatus: 'failed',
            syncError,
            // Kept so the UI can tell the one operator-fixable rejection (bad field values)
            // from the three that are not. Only VALIDATION_ERROR unlocks correct-and-resubmit.
            lastSubmitOutcome: result.outcome,
            serverStatus:
              result.outcome === 'EXPIRED'
                ? 'EXPIRED'
                : result.outcome === 'CANCELLED'
                ? 'CANCELLED'
                : result.outcome === 'SUPERSEDED'
                ? 'SUBMITTED'
                : ls.serverStatus
          })
          failedCount++
        }
      }

      if (pendingFaultReports.length > 0) {
        const payloads = pendingFaultReports.map(r => ({
          logSheetId: Number(r.logSheetServerId),
          assetId: Number(r.assetId),
          reason: r.reason,
          createdAt: r.createdAt,
          clientActionId: r.clientActionId,
          localId: r.id
        }))
        const reportResults = await submitNfcFaultReportsBatch(
          payloads,
          this.abortController.signal
        )

        // Same reasoning as the log-sheet batch above.
        const pendingReportsById = new Map(pendingFaultReports.map(r => [r.id, r]))

        for (const result of reportResults) {
          const report = pendingReportsById.get(result.localId)
          if (!report) continue

          if (result.outcome === 'CREATED' || result.outcome === 'DUPLICATE') {
            await updateNfcFaultReportSyncStatus(report.id, 'synced', {
              serverId: result.serverId != null ? toIdString(result.serverId) : undefined,
              syncedAt: Date.now()
            })
            syncedCount++
          } else {
            await updateNfcFaultReportSyncStatus(report.id, 'failed', {
              syncError: result.error ?? 'خطای ناشناخته'
            })
            failedCount++
          }
        }
      }

      const remaining = await this.refreshPendingCount()
      await cleanupLocalLogSheets()
      this.emit({ type: 'complete', syncedCount, failedCount, pendingCount: remaining })
      await this.syncAttachments()
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

  /**
   * Drains the progress queue.
   *
   * Isolated in its own try/catch, exactly like the attachment pass and for the same reason: a
   * live report about unfinished work must never fail a submission, and the next tick retries it
   * regardless. Nothing it does touches `syncStatus`, so a failure here cannot show up as
   * undelivered work.
   */
  private async pushProgress(): Promise<void> {
    try {
      await pushPendingLogSheetProgress(this.abortController?.signal)
    } catch (err) {
      console.warn('Log sheet progress pass failed', err)
    }
  }

  /**
   * Drains the attachment queue.
   *
   * Isolated in its own try/catch: a photo that will not upload must never fail the log-sheet
   * submission that already succeeded. The readings are the record of work; the media is
   * supporting context, and it retries on the next pass regardless.
   */
  private async syncAttachments(): Promise<void> {
    try {
      await syncPendingAttachments(this.abortController?.signal)
    } catch (err) {
      console.warn('Attachment sync pass failed', err)
    }
  }

  private async markExpiredSheets(): Promise<void> {
    const userId = await getSessionUserId()
    const all = await getAllLogSheets()
    for (const ls of all) {
      if (ls.status !== 'submitted' || ls.syncStatus === 'synced') continue
      // Shared tablet: never expire another assignee's queued submission.
      if (ls.assigneeUserId && userId && ls.assigneeUserId !== userId) continue
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
    const canSyncFaultReports = session
      ? hasPermission(session, PERM_NFC_FAULT_REPORT)
      : false
    const [logSheets, faultReports, attachments] = await Promise.all([
      this.getPendingLogSheets(),
      canSyncFaultReports ? this.getPendingFaultReports() : Promise.resolve([]),
      // Counted too: the badge means "work not yet on the server", and a submitted sheet
      // whose photos are still queued is exactly that. Only uploadable rows count — an
      // attachment whose sheet has not synced yet is represented by that sheet instead, and
      // one belonging to another operator's work on this shared tablet is not this user's to
      // deliver, so counting it would show a badge that never drains.
      getOwnPendingAttachments(),
    ])
    return logSheets.length + faultReports.length + attachments.length
  }

  private async getPendingLogSheets(): Promise<LogSheet[]> {
    const userId = await getSessionUserId()
    const live = await this.getPendingLiveLogSheets(userId)
    const archived = await this.getPendingArchivedLogSheets(userId, live)
    return [...live, ...archived]
  }

  private async getPendingLiveLogSheets(userId: string | null): Promise<LogSheet[]> {
    const all = await getAllLogSheets()
    return all.filter(
      ls =>
        isLogSheetOutboundOwnedByUser(ls, userId) &&
        ls.serverId &&
        !isLogSheetExpiredForSync(ls)
    )
  }

  /**
   * Completions this user made that were archived when someone else took the sheet over
   * on this device. They are no longer reachable from `logSheets`, but the server still
   * has to see them — otherwise the work vanishes with no void record. A live row for the
   * same sheet always wins, so nothing is ever submitted twice.
   */
  private async getPendingArchivedLogSheets(
    userId: string | null,
    live: LogSheet[]
  ): Promise<LogSheet[]> {
    if (!userId) return []
    const archived = await getArchivedSubmissionsPendingServerOutcome(userId)
    if (archived.length === 0) return []
    const liveServerIds = new Set(live.map(ls => toIdString(ls.serverId!)))
    return archived.filter(a => !liveServerIds.has(toIdString(a.serverId!)))
  }

  /**
   * Route a sync result back to the archive row rather than the live `logSheets` row —
   * after a takeover the live row has the same localId but belongs to another user.
   * `syncedAt` marks the archive as resolved so a rejected push is not retried forever.
   */
  private async applyArchivedLogSheetOutcome(
    ref: { serverId: string; userId: string },
    outcome: string | undefined,
    syncError: string | undefined
  ): Promise<void> {
    const accepted = outcome === 'SUBMITTED' || outcome === 'DUPLICATE'
    await updateArchivedLogSheetSnapshot(
      ref.serverId,
      ref.userId,
      accepted
        ? {
            syncStatus: 'synced',
            syncedAt: Date.now(),
            serverStatus: 'SUBMITTED',
            syncError: undefined
          }
        : { syncedAt: Date.now(), syncError }
    )
  }

  private async getPendingFaultReports(): Promise<NfcFaultReport[]> {
    const userId = await getSessionUserId()
    return getPendingNfcFaultReports(userId)
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
