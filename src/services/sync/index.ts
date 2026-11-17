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
  isOwnershipReassignError,
  normalizeLogSheetSyncError
} from '@/utils/logSheetStatus'
import type { LogSheet, NfcFaultReport } from '@/types'
import { toIdString } from '@/utils/ids'
import { clearLocalEditMarkers } from '@/utils/logSheetLocalData'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import { reportUndeliveredBacklogIfChanged } from '@/services/sync/backlogReport'
import { v4 as uuidv4 } from 'uuid'

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
  /**
   * Progress pushes, one after another. The timer's pass and an immediate request
   * (`pushProgressNow`) both join this lane, so two passes never build payloads from the same
   * markers at once — which would be harmless on the server (it is idempotent by value) but
   * would send the same answers twice.
   */
  private progressLane: Promise<void> = Promise.resolve()

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

    // No local expiry of queued completions any more (issue P-02). `markExpiredSheets` used to
    // turn a round finished after its deadline into `failed`/EXPIRED here, before anything was
    // sent, "so it does not queue work the server is certain to refuse" — which removed the one
    // chance that work had of being kept, since the server's answer to it is to keep it (backend
    // V25, B-01). The server decides now; the device sends once and records what it was told.

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
      await this.reportBacklog()
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

          // Backend V25 (issues P-02, B-01): a refusal the server KEPT for review. The row stays
          // failed exactly as before — the round was not applied — but the device now knows its
          // readings are no longer only here, which is what the «ارسال‌نشده» count reads.
          const serverKeptAt = result.kept === true ? Date.now() : undefined

          if (isOwnershipReassignError(syncError)) {
            await updateLogSheet(ls.localId, {
              syncStatus: 'failed',
              syncError,
              lastSubmitOutcome: result.outcome,
              ...(serverKeptAt != null ? { serverKeptAt } : {})
            })
            failedCount++
            continue
          }

          await updateLogSheet(ls.localId, {
            syncStatus: 'failed',
            syncError,
            ...(serverKeptAt != null ? { serverKeptAt } : {}),
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
      await this.reportBacklog()
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
    const pass = this.progressLane.then(async () => {
      try {
        await pushPendingLogSheetProgress(this.abortController?.signal)
      } catch (err) {
        console.warn('Log sheet progress pass failed', err)
      }
    })
    this.progressLane = pass
    return pass
  }

  /**
   * Delivers pending progress now rather than at the next tick — for a save the operator makes
   * deliberately, with a button, and expects the supervisor to see.
   *
   * Only the progress lane: no inbox pull and no submit batch, so it costs one small request.
   * Used for the round's own questions, which are saved once or a few times per round; an asset
   * save stays on the timer, because a round of forty assets would otherwise be forty requests
   * (backend roadmap §3 — the inbox tick is already the fleet's cost driver).
   *
   * Never throws. Offline, signed out, or without the progress permission it does nothing, and
   * the next tick delivers the same answers.
   */
  async pushProgressNow(): Promise<void> {
    if (!navigator.onLine) return
    try {
      const session = await getAuthSession()
      if (!session || !hasPermission(session, PERM_LOG_SHEET_PROGRESS)) return
      if (!(await ensureSessionUserId())) return
      await this.pushProgress()
    } catch (err) {
      console.warn('Immediate progress push failed', err)
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

  /**
   * Tells the panel how many rounds on this tablet hold readings the server has received in no
   * form (backend V25), when that number has changed or an hour has passed. Best-effort and
   * isolated like the attachment pass: it is information for a supervisor, and nothing about it
   * may fail or delay a delivery. An older server answers 403/404, which is swallowed.
   */
  private async reportBacklog(): Promise<void> {
    try {
      await reportUndeliveredBacklogIfChanged(this.abortController?.signal)
    } catch (err) {
      console.warn('Backlog report failed', err)
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
    // No deadline filter any more (issue P-02). A completion finished after its deadline goes out
    // once like any other; the server answers EXPIRED and — from backend V25 — keeps it, and the
    // row then leaves this queue as `failed` (`isLogSheetOutboundOwnedByUser` never takes a failed
    // row back). An on-time completion the scheduler expired meanwhile is accepted by the server
    // on its `completedAt`, as it always was.
    const pending = all.filter(ls => isLogSheetOutboundOwnedByUser(ls, userId) && ls.serverId)
    // Issue P-07: a queued completion must carry ONE idempotency key for every attempt. The fill
    // page stamps it at completion, but a row without one used to get a fresh key per pass from
    // `toBatchPayload`'s fallback — so the server's replay check could never match, and a retry
    // after a lost response to a refused round was kept as a second void row. Persisted here,
    // before the first send, so every retry carries the same key.
    for (const ls of pending) {
      if (ls.clientActionId) continue
      const clientActionId = uuidv4()
      await updateLogSheet(ls.localId, { clientActionId })
      ls.clientActionId = clientActionId
    }
    return pending
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
