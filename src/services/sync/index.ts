/**
 * SyncManager — handles all outbound data synchronization.
 */

import {
  getAllLogSheets,
  getLogSheetsByStatus,
  updateLogSheet,
} from '@/services/storage'
import {
  getPendingNfcFaultReports,
  updateNfcFaultReportSyncStatus
} from '@/services/storage/nfcFaultReports'
import {
  submitLogSheetsBatch,
  submitNfcFaultReportsBatch,
  type LogSheetSubmitResult,
  type NfcFaultReportSubmitResult
} from '@/services/api'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import { getOwnPendingAttachments, syncPendingAttachments } from '@/services/sync/attachmentSync'
import { pushPendingLogSheetProgress } from '@/services/sync/progressSync'
import { pushPendingFormDrafts } from '@/services/sync/formDraftSync'
import { pushPendingFormFinals } from '@/services/sync/formSubmitSync'
import { bindAttachmentsToServerSheet } from '@/services/storage/attachments'
import { getPendingFormFinals } from '@/services/storage/formSubmissions'
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
import {
  hasPermission,
  PERM_FORMS_DRAFT,
  PERM_FORMS_SUBMIT,
  PERM_LOG_SHEET_PROGRESS,
  PERM_NFC_FAULT_REPORT
} from '@/types/auth'
import {
  isOwnershipReassignError,
  normalizeLogSheetSyncError,
  SYNC_OUTCOME_MESSAGES
} from '@/utils/logSheetStatus'
import type { LogSheet, NfcFaultReport } from '@/types'
import { toIdString } from '@/utils/ids'
import { clearLocalEditMarkers } from '@/utils/logSheetLocalData'
import { purgeLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import { cleanupLocalFormSubmissions } from '@/services/sync/cleanupFormSubmissions'
import { reportUndeliveredBacklogIfChanged } from '@/services/sync/backlogReport'
import {
  payloadBytes,
  submitInChunks,
  type ChunkedSubmitOutcome
} from '@/services/sync/submitChunks'
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

/**
 * Passes in a row whose submit the server refused outright before the sync indicator says so
 * (issue P-04). One refusal can be a deploy in progress; three in a row — a minute and a half — is
 * a tablet whose work is stuck, which the operator and their supervisor need to see.
 */
export const REFUSED_PASSES_BEFORE_SHOWING = 3

/** What one pass delivered and what it could not, across both queues. */
interface PassTally {
  synced: number
  failed: number
}

/** The NFC fault report as the batch endpoint takes it. */
function toFaultReportPayload(report: NfcFaultReport) {
  return {
    logSheetId: Number(report.logSheetServerId),
    assetId: Number(report.assetId),
    reason: report.reason,
    createdAt: report.createdAt,
    clientActionId: report.clientActionId,
    localId: report.id
  }
}

/**
 * What the device records about whether the server holds a refused round's readings: `kept: true`
 * and `kept: false` (backend V25/V26) each replace the other; an answer saying neither changes
 * nothing, so an older server never erases what a newer one said.
 */
function keptFieldsOf(result: LogSheetSubmitResult): Partial<LogSheet> {
  if (result.kept === true) return { serverKeptAt: Date.now(), serverKeepRefusedAt: undefined }
  if (result.kept === false) return { serverKeepRefusedAt: Date.now(), serverKeptAt: undefined }
  return {}
}

/** The server status a refusal implies — what the round's card shows afterwards. */
function serverStatusAfterRefusal(
  outcome: LogSheetSubmitResult['outcome'],
  current: LogSheet['serverStatus']
): LogSheet['serverStatus'] {
  switch (outcome) {
    case 'EXPIRED':
      return 'EXPIRED'
    case 'CANCELLED':
      return 'CANCELLED'
    case 'SUPERSEDED':
      return 'SUBMITTED'
    default:
      return current
  }
}

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
  /** Consecutive passes with a refused request — see {@link REFUSED_PASSES_BEFORE_SHOWING}. */
  private refusedPasses = 0

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
    // Carrier 3 draft upsert — best-effort, isolated like progress; never fails submit lanes.
    if (hasPermission(session, PERM_FORMS_DRAFT)) {
      await this.pushFormDrafts()
    }

    const canSyncFaultReports = hasPermission(session, PERM_NFC_FAULT_REPORT)
    const canSyncFormFinals = hasPermission(session, PERM_FORMS_SUBMIT)

    const [pendingLogSheets, pendingFaultReports, pendingFormFinals] = await Promise.all([
      this.getPendingLogSheets(),
      canSyncFaultReports ? this.getPendingFaultReports() : Promise.resolve([]),
      canSyncFormFinals ? getPendingFormFinals(sessionUserId) : Promise.resolve([]),
    ])

    const totalPending =
      pendingLogSheets.length + pendingFaultReports.length + pendingFormFinals.length
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

    const tally: PassTally = { synced: 0, failed: 0 }

    try {
      const sheetsOutcome = await this.submitLogSheets(pendingLogSheets, tally)
      // A dead link stops the pass: the fault reports would only meet the same dead link.
      const reportsOutcome = sheetsOutcome.transientError
        ? {}
        : await this.submitFaultReports(pendingFaultReports, tally)

      const formsOutcome =
        sheetsOutcome.transientError || reportsOutcome.transientError
          ? {}
          : await this.submitFormFinals(pendingFormFinals, tally)

      const transientError =
        sheetsOutcome.transientError ??
        reportsOutcome.transientError ??
        formsOutcome.transientError
      if (transientError) {
        await this.emitTransientFailure(transientError, tally)
        return
      }

      const remaining = await this.refreshPendingCount()
      // The pass's one read of the whole table (issue P-08): purged, and the survivors handed on.
      const survivors = await purgeLocalLogSheets(await getAllLogSheets())
      // Same deviceRetention windows as rounds — never touches undelivered form drafts.
      await cleanupLocalFormSubmissions()
      this.emit({ type: 'complete', syncedCount: tally.synced, failedCount: tally.failed, pendingCount: remaining })
      this.noteRefusals(
        sheetsOutcome.refusedError ?? reportsOutcome.refusedError,
        tally,
        remaining
      )
      await this.reportBacklog(survivors)
      await this.syncAttachments()
    } catch (err) {
      await this.emitTransientFailure(
        err instanceof Error ? err.message : 'خطا در ارتباط با سرور',
        tally
      )
    } finally {
      this.isSyncing = false
      this.abortController = null
    }
  }

  /**
   * A pass that stopped because the link did — keep everything pending, and do not flash an error
   * at the operator for what is usually a weak signal.
   */
  private async emitTransientFailure(error: string, tally: PassTally): Promise<void> {
    this.emit({ type: 'error', failedCount: tally.failed, transient: true, error })
    await this.refreshPendingCount()
  }

  /**
   * Counts passes in which the server refused a whole request (issue P-04), and says so once it
   * has happened {@link REFUSED_PASSES_BEFORE_SHOWING} times in a row. The refused items are still
   * queued and still retried every pass — this only stops it being silent.
   */
  private noteRefusals(refusedError: string | undefined, tally: PassTally, remaining: number): void {
    if (!refusedError) {
      this.refusedPasses = 0
      return
    }
    this.refusedPasses++
    if (this.refusedPasses < REFUSED_PASSES_BEFORE_SHOWING) return
    this.emit({
      type: 'error',
      transient: false,
      error: refusedError,
      failedCount: tally.failed,
      pendingCount: remaining
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Completed rounds
  // ---------------------------------------------------------------------------------------------

  private async submitLogSheets(sheets: LogSheet[], tally: PassTally): Promise<ChunkedSubmitOutcome> {
    if (sheets.length === 0) return {}
    const items = sheets.map(sheet => ({ sheet, payload: toBatchPayload(sheet) }))
    const byLocalId = new Map(sheets.map(sheet => [sheet.localId, sheet]))
    const signal = this.abortController?.signal

    return submitInChunks(items, {
      send: chunk => submitLogSheetsBatch(chunk.map(item => item.payload), signal),
      sizeOf: item => payloadBytes(item.payload),
      onResults: async results => {
        for (const result of results) {
          const sheet = byLocalId.get(result.localId)
          if (!sheet) continue
          if (await this.applyLogSheetResult(sheet, result)) tally.synced++
          else tally.failed++
        }
      },
      onOversized: async item => {
        await this.markLogSheetTooLarge(item.sheet)
        tally.failed++
      }
    })
  }

  /** Records the server's answer for one round. @returns whether the round is now delivered. */
  private async applyLogSheetResult(sheet: LogSheet, result: LogSheetSubmitResult): Promise<boolean> {
    const archivedRef = parseArchivedLogSheetViewId(sheet.localId)
    if (archivedRef) {
      const accepted = result.outcome === 'SUBMITTED' || result.outcome === 'DUPLICATE'
      await this.applyArchivedLogSheetOutcome(
        archivedRef,
        result.outcome,
        accepted ? undefined : normalizeLogSheetSyncError(result.outcome, result.error)
      )
      return accepted
    }

    // DUPLICATE is delivery only with a server id: the server already holds this work.
    const delivered =
      result.outcome === 'SUBMITTED' || (result.outcome === 'DUPLICATE' && result.serverId != null)
    if (delivered) {
      await this.markLogSheetDelivered(sheet, toIdString(result.serverId ?? sheet.serverId))
      return true
    }
    await this.markLogSheetRefused(sheet, result)
    return false
  }

  private async markLogSheetDelivered(sheet: LogSheet, serverId: string): Promise<void> {
    await updateLogSheet(sheet.localId, {
      syncStatus: 'synced',
      syncedAt: Date.now(),
      serverId,
      serverStatus: 'SUBMITTED',
      syncError: undefined,
      lastSubmitOutcome: undefined,
      // The work is the server's now, so this device stops claiming an opinion of its own about
      // these entries. Leaving the markers would make it win every later merge for them —
      // including after a supervisor reopens the sheet and edits it.
      entries: clearLocalEditMarkers(sheet.entries),
      // Delivered work needs no progress report. The queue would skip this row anyway (it only
      // takes drafts, and the markers above are gone), so this is tidiness rather than a guard —
      // but a stale «pending» on a completed round reads as something still outstanding.
      progressSyncStatus: undefined,
      progressError: undefined
    })
    if (!serverId) return
    // The sheet now exists on the server, so its attachments finally have somewhere to go. Until
    // this stamp lands the upload queue skips them by design.
    await bindAttachmentsToServerSheet(sheet.localId, serverId)
    const ownerId = await getSessionUserId()
    if (ownerId) {
      await removeArchivedLogSheet(serverId, ownerId)
    }
  }

  private async markLogSheetRefused(sheet: LogSheet, result: LogSheetSubmitResult): Promise<void> {
    const syncError = normalizeLogSheetSyncError(result.outcome, result.error)
    // Backend V25/V26 (issues P-02, B-01, P-05): whether the server KEPT the refused round. The
    // row stays failed either way — it was not applied — but the device now knows whether its
    // readings are only here, which is what the «ارسال‌نشده» count and the local purge read.
    const kept = keptFieldsOf(result)

    if (isOwnershipReassignError(syncError)) {
      await updateLogSheet(sheet.localId, {
        syncStatus: 'failed',
        syncError,
        lastSubmitOutcome: result.outcome,
        ...kept
      })
      return
    }

    await updateLogSheet(sheet.localId, {
      syncStatus: 'failed',
      syncError,
      ...kept,
      // Kept so the UI can tell the one operator-fixable rejection (bad field values) from the
      // three that are not. Only VALIDATION_ERROR unlocks correct-and-resubmit.
      lastSubmitOutcome: result.outcome,
      serverStatus: serverStatusAfterRefusal(result.outcome, sheet.serverStatus)
    })
  }

  /**
   * A round the server refuses as too large even in a request of its own (issue P-04). Marked
   * failed with a message that says so — it is kept on the device, and the «ارسال‌نشده» count
   * shows it — rather than re-sent into the same refusal every thirty seconds.
   */
  private async markLogSheetTooLarge(sheet: LogSheet): Promise<void> {
    const syncError = SYNC_OUTCOME_MESSAGES.TOO_LARGE
    const archivedRef = parseArchivedLogSheetViewId(sheet.localId)
    if (archivedRef) {
      await this.applyArchivedLogSheetOutcome(archivedRef, 'ERROR', syncError)
      return
    }
    await updateLogSheet(sheet.localId, { syncStatus: 'failed', syncError, lastSubmitOutcome: 'ERROR' })
  }

  // ---------------------------------------------------------------------------------------------
  // NFC fault reports
  // ---------------------------------------------------------------------------------------------

  private async submitFaultReports(
    reports: NfcFaultReport[],
    tally: PassTally
  ): Promise<ChunkedSubmitOutcome> {
    if (reports.length === 0) return {}
    const byId = new Map(reports.map(report => [report.id, report]))
    const signal = this.abortController?.signal

    return submitInChunks(reports, {
      send: chunk => submitNfcFaultReportsBatch(chunk.map(toFaultReportPayload), signal),
      sizeOf: report => payloadBytes(toFaultReportPayload(report)),
      onResults: async results => {
        for (const result of results) {
          const report = byId.get(result.localId)
          if (!report) continue
          if (await this.applyFaultReportResult(report, result)) tally.synced++
          else tally.failed++
        }
      },
      onOversized: async report => {
        await updateNfcFaultReportSyncStatus(report.id, 'failed', {
          syncError: SYNC_OUTCOME_MESSAGES.TOO_LARGE
        })
        tally.failed++
      }
    })
  }

  /** @returns whether the server now holds the report. */
  private async applyFaultReportResult(
    report: NfcFaultReport,
    result: NfcFaultReportSubmitResult
  ): Promise<boolean> {
    if (result.outcome === 'CREATED' || result.outcome === 'DUPLICATE') {
      await updateNfcFaultReportSyncStatus(report.id, 'synced', {
        serverId: result.serverId != null ? toIdString(result.serverId) : undefined,
        syncedAt: Date.now()
      })
      return true
    }
    await updateNfcFaultReportSyncStatus(report.id, 'failed', {
      syncError: result.error ?? 'خطای ناشناخته'
    })
    return false
  }

  // ---------------------------------------------------------------------------------------------
  // The lanes beside the submit
  // ---------------------------------------------------------------------------------------------

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
   * Form draft upserts — own lane, never writes final-submit fields, never fails the pass.
   * Runs after log-sheet progress so a tablet walking a round and filing a form still reports
   * both; order between the two best-effort lanes is not load-bearing.
   */
  private formDraftLane: Promise<void> = Promise.resolve()

  private async pushFormDrafts(): Promise<void> {
    const pass = this.formDraftLane.then(async () => {
      try {
        await pushPendingFormDrafts(this.abortController?.signal)
      } catch (err) {
        console.warn('Form draft pass failed', err)
      }
    })
    this.formDraftLane = pass
    return pass
  }

  /** Immediate draft push after a deliberate save — mirrors `pushProgressNow`. */
  async pushFormDraftsNow(): Promise<void> {
    if (!navigator.onLine) return
    try {
      const session = await getAuthSession()
      if (!session || !hasPermission(session, PERM_FORMS_DRAFT)) return
      if (!(await ensureSessionUserId())) return
      await this.pushFormDrafts()
    } catch (err) {
      console.warn('Immediate form draft push failed', err)
    }
  }

  private async submitFormFinals(
    pending: Awaited<ReturnType<typeof getPendingFormFinals>>,
    tally: PassTally
  ): Promise<{ transientError?: string }> {
    if (pending.length === 0) return {}
    try {
      const result = await pushPendingFormFinals(this.abortController?.signal)
      tally.synced += result.synced
      tally.failed += result.failed
      if (result.transientError) return { transientError: result.transientError }
      return {}
    } catch (err) {
      return {
        transientError: err instanceof Error ? err.message : 'خطا در ارسال فرم'
      }
    }
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
   *
   * @param sheets every local round, when this pass has just read them (issue P-08)
   */
  private async reportBacklog(sheets?: LogSheet[]): Promise<void> {
    try {
      await reportUndeliveredBacklogIfChanged(this.abortController?.signal, Date.now(), sheets)
    } catch (err) {
      console.warn('Backlog report failed', err)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The queue
  // ---------------------------------------------------------------------------------------------

  async getPendingCount(): Promise<number> {
    const session = await getAuthSession()
    const canSyncFaultReports = session
      ? hasPermission(session, PERM_NFC_FAULT_REPORT)
      : false
    const canSyncFormFinals = session ? hasPermission(session, PERM_FORMS_SUBMIT) : false
    const sessionUserId = await getSessionUserId()
    const [logSheets, faultReports, formFinals, attachments] = await Promise.all([
      this.getPendingLogSheets(),
      canSyncFaultReports ? this.getPendingFaultReports() : Promise.resolve([]),
      // Final submits only — draft upserts are progress-like and stay out of the badge.
      canSyncFormFinals ? getPendingFormFinals(sessionUserId) : Promise.resolve([]),
      // Counted too: the badge means "work not yet on the server", and a submitted sheet
      // whose photos are still queued is exactly that. Only uploadable rows count — an
      // attachment whose sheet has not synced yet is represented by that sheet instead, and
      // one belonging to another operator's work on this shared tablet is not this user's to
      // deliver, so counting it would show a badge that never drains.
      getOwnPendingAttachments(),
    ])
    return logSheets.length + faultReports.length + formFinals.length + attachments.length
  }

  private async getPendingLogSheets(): Promise<LogSheet[]> {
    const userId = await getSessionUserId()
    const live = await this.getPendingLiveLogSheets(userId)
    const archived = await this.getPendingArchivedLogSheets(userId, live)
    return [...live, ...archived]
  }

  private async getPendingLiveLogSheets(userId: string | null): Promise<LogSheet[]> {
    // Only `submitted` rows can be queued (`isLogSheetOutboundOwnedByUser`), so only those are
    // read — through the status index, on every tick and every badge refresh (issue P-08).
    const submitted = await getLogSheetsByStatus('submitted')
    // No deadline filter any more (issue P-02). A completion finished after its deadline goes out
    // once like any other; the server answers EXPIRED and — from backend V25 — keeps it, and the
    // row then leaves this queue as `failed` (`isLogSheetOutboundOwnedByUser` never takes a failed
    // row back). An on-time completion the scheduler expired meanwhile is accepted by the server
    // on its `completedAt`, as it always was.
    const pending = submitted.filter(ls => isLogSheetOutboundOwnedByUser(ls, userId) && ls.serverId)
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
