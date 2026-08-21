import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { loadLogSheetsForSessionUser } from '@/services/auth/sessionContext'
import {
  archiveLogSheetForUser,
  getArchivedLogSheetsForUser
} from '@/services/storage/logSheetArchive'
import { buildRestorePlan, restoreArchivedEntries } from '@/services/storage/restoreArchivedWork'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import { toIdString } from '@/utils/ids'
import type { LogSheetBundleDto } from '@/services/api'
import type { LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'

const submitLogSheetsBatch = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...args: unknown[]) => submitLogSheetsBatch(...args),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * The reported sequence, end to end, with the restore at the end of it.
 *
 * <h2>What this covers that the unit tests do not</h2>
 *
 * `restoreArchivedWork.test.ts` drives the plan and the write against hand-placed rows. This
 * file never places a row: it starts from an operator filling a sheet, lets `applyLogSheetBundle`
 * do the archiving and the clearing, lets it do them again when the sheet comes back, and only
 * then restores. So it is the one place where the archive under test is an archive the shipping
 * sync path actually produced — including the attachment rows, which the clear leaves behind and
 * which nothing but the restore ever re-references.
 *
 * <h2>The sequence</h2>
 *
 * <ol>
 *   <li>Operator 1 claims the round, goes offline, fills two assets and photographs one of them.
 *       Nothing is submitted.</li>
 *   <li>A supervisor reassigns the sheet to operator 2. Coming back online clears the live row —
 *       the tablet is shared — after archiving the readings.</li>
 *   <li>The supervisor gives the sheet back. The archive card stays visible (the earlier fix),
 *       and the live sheet is empty.</li>
 *   <li>The operator restores. Readings return, the photographs return with them, and the archive
 *       goes away.</li>
 * </ol>
 */

const OP1 = '7'
const OP2 = '8'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000
const RESTORED_AT = NOW + 900_000

const A1 = '11'
const A2 = '12'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function blankEntry(assetId: string): LogSheetEntryData {
  return {
    assetId,
    assetName: `پمپ ${assetId}`,
    subFunctionCode: `SF-${assetId}`,
    subFunctionTag: `TAG-${assetId}`,
    classId: '2',
    formData: {}
  }
}

function localSheet(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: OP1,
    localOwnerUserId: OP1,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    entries: [blankEntry(A1), blankEntry(A2)],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function bundle(assignee: string | null, status = 'ASSIGNED'): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status,
      assigneeUserId: assignee == null ? null : Number(assignee),
      dueAt: NOW + 3_600_000,
      createdAt: NOW - 60_000,
      updatedAt: NOW
    },
    entries: [A1, A2].map(assetId => ({
      assetId: Number(assetId),
      assetName: `پمپ ${assetId}`,
      subFunctionCode: `SF-${assetId}`,
      subFunctionTag: `TAG-${assetId}`,
      classId: 2,
      formData: {},
      createdAt: NOW - 10_000,
      updatedAt: NOW - 5_000
    })),
    context: null
  } as LogSheetBundleDto
}

function photo(id: string, assetId: string, createdAt = NOW): LocalAttachment {
  return {
    id,
    logSheetLocalId: 'local-1',
    logSheetServerId: SERVER_ID,
    assetId,
    fieldKey: 'photo',
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 1024,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'pending',
    createdAt
  } as LocalAttachment
}

function readingsOn(sheet: LogSheet | undefined, assetId: string): Record<string, unknown> {
  return sheet?.entries.find(e => toIdString(e.assetId) === assetId)?.formData ?? {}
}

async function cardsFor(userId: string): Promise<LogSheet[]> {
  return loadLogSheetsForSessionUser(await db.logSheets.toArray(), userId, new Set())
}

/**
 * Steps 1–3: the operator's offline round, the handover, and the sheet coming back.
 *
 * <p>Every write here goes through the shipping path — `saveLogSheet` for the operator's own
 * edits, `applyLogSheetBundle` for both server updates — so the state the restore then acts on
 * is the state production would leave behind.
 */
async function upToTheSheetComingBack(): Promise<void> {
  await saveLogSheet(localSheet())

  // The operator fills two assets and photographs the first. The photos are separate rows; the
  // form value is only a list of their ids.
  await db.attachments.bulkPut([photo('p1', A1), photo('p2', A1, NOW + 1)])
  const held = (await getLogSheetByServerId(SERVER_ID))!
  await saveLogSheet({
    ...held,
    entries: held.entries.map(e => {
      if (toIdString(e.assetId) === A1) {
        return applyOperatorEntrySave(
          e,
          { temp: 42, photo: buildAttachmentRef(['p1', 'p2']) },
          'manual',
          NOW
        )
      }
      if (toIdString(e.assetId) === A2) {
        return applyOperatorEntrySave(e, { temp: 51 }, 'manual', NOW)
      }
      return e
    })
  })

  await applyLogSheetBundle(bundle(OP2)) // reassigned away — archived, live row cleared
  await applyLogSheetBundle(bundle(OP1)) // and handed back
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.logSheetUserArchives.clear()
  await db.attachments.clear()
  await db.fieldDefinitions.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(OP1) })
  submitLogSheetsBatch.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 1_000)
  vi.stubGlobal('navigator', { onLine: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// The state the restore starts from
// ─────────────────────────────────────────────────────────────────────────────

describe('the state a real round trip leaves behind', () => {
  it('empties the live sheet but leaves every photo on the device', async () => {
    // This is the half of the bug that could not be worked around: readings can be retyped,
    // a reference to a file that is no longer referenced cannot be.
    await upToTheSheetComingBack()

    expect(readingsOn(await getLogSheetByServerId(SERVER_ID), A1)).toEqual({})
    expect(readingsOn(await getLogSheetByServerId(SERVER_ID), A2)).toEqual({})
    expect(await db.attachments.count()).toBe(2)
  })

  it('keeps the archived card, holding both assets', async () => {
    await upToTheSheetComingBack()

    const archived = (await cardsFor(OP1)).find(c => c.localId.startsWith('archive:'))
    expect(readingsOn(archived, A1).temp).toBe(42)
    expect(readingsOn(archived, A2).temp).toBe(51)
  })

  it('offers both assets for restore, with the photos counted', async () => {
    await upToTheSheetComingBack()

    const plan = (await buildRestorePlan(SERVER_ID, OP1))!

    expect(plan.assets.map(a => a.assetId)).toEqual([A1, A2])
    expect(plan.assets[0].attachmentIds).toEqual(['p1', 'p2'])
    expect(plan.assets.every(a => !a.conflict)).toBe(true)
    expect(plan.liveLocalId).toBe('local-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The restore
// ─────────────────────────────────────────────────────────────────────────────

describe('restoring after a real round trip', () => {
  it('puts the readings back on the live sheet', async () => {
    await upToTheSheetComingBack()

    await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readingsOn(live, A1).temp).toBe(42)
    expect(readingsOn(live, A2).temp).toBe(51)
  })

  it('puts the photo references back, exactly the files the device still holds', async () => {
    await upToTheSheetComingBack()

    await restoreArchivedEntries(SERVER_ID, OP1, [A1], RESTORED_AT)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(attachmentIdsOf(readingsOn(live, A1).photo)).toEqual(['p1', 'p2'])
  })

  it('moves no file and deletes none', async () => {
    // A restore is a reference-level operation. Touching a blob would risk the one thing on this
    // device that cannot be recreated.
    await upToTheSheetComingBack()
    const before = (await db.attachments.toArray()).map(a => ({
      id: a.id,
      assetId: a.assetId,
      fieldKey: a.fieldKey,
      syncStatus: a.syncStatus,
      pendingDelete: a.pendingDelete
    }))

    await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    const after = (await db.attachments.toArray()).map(a => ({
      id: a.id,
      assetId: a.assetId,
      fieldKey: a.fieldKey,
      syncStatus: a.syncStatus,
      pendingDelete: a.pendingDelete
    }))
    expect(after).toEqual(before)
  })

  it('drops the archive once nothing restorable is left', async () => {
    await upToTheSheetComingBack()

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    expect(outcome.archiveCleared).toBe(true)
    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(0)
    expect((await cardsFor(OP1)).filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })

  it('keeps the archive reachable after a partial restore', async () => {
    // The failure mode this whole feature exists to avoid is work that is on the device and
    // reachable from nowhere. A half-finished restore must not recreate it.
    await upToTheSheetComingBack()

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [A1], RESTORED_AT)

    expect(outcome.archiveCleared).toBe(false)
    expect(readingsOn((await getArchivedLogSheetsForUser(OP1))[0], A2).temp).toBe(51)
    expect((await buildRestorePlan(SERVER_ID, OP1))!.assets.map(a => a.assetId)).toEqual([A2])
  })

  it('leaves the restored sheet as the operator own work, ready to submit', async () => {
    await upToTheSheetComingBack()

    await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    const live = (await getLogSheetByServerId(SERVER_ID))!
    expect(live.status).toBe('draft')
    expect(String(live.assigneeUserId)).toBe(OP1)
    expect(live.entries.every(e => e.locallyEditedAt === RESTORED_AT)).toBe(true)
  })

  it('survives the next bundle from the server', async () => {
    // The reason `locallyEditedAt` is stamped at restore time. A refresh arriving a moment later
    // must not wash the restored values away, or the operator would watch them vanish twice.
    await upToTheSheetComingBack()
    await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    await applyLogSheetBundle(bundle(OP1, 'IN_PROGRESS'))

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readingsOn(live, A1).temp).toBe(42)
    expect(attachmentIdsOf(readingsOn(live, A1).photo)).toEqual(['p1', 'p2'])
    expect(readingsOn(live, A2).temp).toBe(51)
  })

  it('refuses once the sheet has moved on again', async () => {
    // A background sync between opening the dialog and confirming it. Refusing is the whole
    // point: the alternative is writing over an operator who now owns the sheet.
    await upToTheSheetComingBack()

    await applyLogSheetBundle(bundle(OP2))
    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    expect(outcome.refusal).toBe('not-your-work')
    expect(outcome.restoredAssetIds).toEqual([])
    expect(readingsOn(await getLogSheetByServerId(SERVER_ID), A1)).toEqual({})
    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(1)
  })

  it('does not offer a restore to a different operator on the same tablet', async () => {
    // Archives are keyed by (sheet, user). Operator 2 signing in must see nothing to restore,
    // whatever operator 1 left behind.
    await upToTheSheetComingBack()

    expect(await buildRestorePlan(SERVER_ID, OP2)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Two passes — the case that reintroduced the original bug
// ─────────────────────────────────────────────────────────────────────────────

describe('a restore finished in two passes', () => {
  /**
   * The regression. After restoring one of two assets the live row holds work, and the archive's
   * visibility rule used to be "a live row this user owns and that holds the work wins" — so the
   * card vanished, taking the restore button with it, and the second asset was stranded on disk
   * exactly the way the original bug stranded everything. Found in a browser, not by a test.
   */
  it('KEEPS the archived card visible while it still holds work the live row lacks', async () => {
    await upToTheSheetComingBack()

    await restoreArchivedEntries(SERVER_ID, OP1, [A1], RESTORED_AT)

    const archived = (await cardsFor(OP1)).find(c => c.localId.startsWith('archive:'))
    expect(archived).toBeDefined()
    expect(readingsOn(archived, A2).temp).toBe(51)
  })

  it('still offers the untouched asset, and only that one', async () => {
    await upToTheSheetComingBack()
    await restoreArchivedEntries(SERVER_ID, OP1, [A1], RESTORED_AT)

    const plan = await buildRestorePlan(SERVER_ID, OP1)

    expect(plan!.assets.map(a => a.assetId)).toEqual([A2])
  })

  it('finishes the job on the second pass and then drops the card', async () => {
    await upToTheSheetComingBack()
    await restoreArchivedEntries(SERVER_ID, OP1, [A1], RESTORED_AT)

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [A2], RESTORED_AT + 1000)

    expect(outcome.archiveCleared).toBe(true)
    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readingsOn(live, A1).temp).toBe(42)
    expect(readingsOn(live, A2).temp).toBe(51)
    expect((await cardsFor(OP1)).filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })

  it('hides the card once the live row covers every archived asset', async () => {
    // The counterweight. Keeping the card alive on a *complete* restore would show the operator
    // a permanent duplicate of work that is already in front of them.
    await upToTheSheetComingBack()

    await restoreArchivedEntries(SERVER_ID, OP1, [A1, A2], RESTORED_AT)

    expect((await cardsFor(OP1)).filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })

  it('does not resurrect the card for a false revoke, where the live row kept everything', async () => {
    // The case the visibility rule was built for in the first place, and the one most at risk
    // from a per-asset check: the live row still holds all the work, so the archive is noise.
    await saveLogSheet(localSheet())
    const held = (await getLogSheetByServerId(SERVER_ID))!
    await saveLogSheet({
      ...held,
      entries: held.entries.map(e =>
        applyOperatorEntrySave(e, { temp: 42 }, 'manual', NOW))
    })
    await archiveLogSheetForUser((await getLogSheetByServerId(SERVER_ID))!, OP1)

    const cards = await cardsFor(OP1)

    expect(cards.filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })
})
