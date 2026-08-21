import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { loadLogSheetsForSessionUser } from '@/services/auth/sessionContext'
import { getArchivedLogSheetsForUser } from '@/services/storage/logSheetArchive'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'

const submitLogSheetsBatch = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...args: unknown[]) => submitLogSheetsBatch(...args),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * A sheet reassigned away from an operator, and then back to them.
 *
 * <h2>The reported failure</h2>
 *
 * An operator claims a round, goes offline and fills some assets **without** submitting. A
 * supervisor reassigns the sheet to somebody else. The operator comes back online, sees "this
 * work is no longer yours" — correct, and their readings are still visible on a read-only
 * archive card. Then the supervisor gives the sheet **back**, and the readings disappear
 * entirely: one empty card, and nothing else.
 *
 * <h2>Why</h2>
 *
 * There is one local row per server sheet, and a tablet is shared — so when ownership moves the
 * row must be cleared, or the next operator would see the previous one's readings. That is what
 * `reset-draft` does, and it archives the work first. The archive was then hidden by
 * `loadLogSheetsForSessionUser`, whose rule was "a live copy this user owns wins". Ownership
 * comes back with the reassignment, so the emptied row won and the only remaining copy of the
 * readings was skipped as stale.
 *
 * The rule is now "a live copy this user owns **and that holds the work** wins", which is the
 * distinction it always meant: a false revoke during sync leaves the values on the live row, a
 * clear does not.
 *
 * <h2>What this file covers</h2>
 *
 * The round trip, and every neighbouring case the change could plausibly have broken — a false
 * revoke, a delivered submission, a shared tablet, and repeated syncs. The archive being visible
 * is a display decision only: nothing is copied back into the live sheet, deliberately. See
 * `roadmap.md` for the explicit-restore design and why an automatic one would be unsafe.
 */

const OP1 = '7'
const OP2 = '8'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000
const READINGS = { temp: 42, note: 'صدای غیرعادی' }

function filledEntry(values: Record<string, unknown> = READINGS): LogSheetEntryData {
  return applyOperatorEntrySave(
    {
      assetId: '7',
      assetName: 'پمپ ۱',
      subFunctionCode: 'SF-1',
      subFunctionTag: 'TAG-1',
      classId: '2',
      formData: {}
    },
    values,
    'manual',
    NOW
  )
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
    entries: [filledEntry()],
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
    entries: [
      {
        assetId: 7,
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: 2,
        formData: {},
        createdAt: NOW - 10_000,
        updatedAt: NOW - 5_000
      }
    ],
    context: null
  } as LogSheetBundleDto
}

/** What the operator's list actually shows. */
async function cardsFor(userId: string): Promise<LogSheet[]> {
  return loadLogSheetsForSessionUser(await db.logSheets.toArray(), userId, new Set())
}

function readingsOn(sheet: LogSheet | undefined): Record<string, unknown> {
  return sheet?.entries[0]?.formData ?? {}
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.logSheetUserArchives.clear()
  await db.syncMeta.clear()
  await db.attachments.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(OP1) })
  submitLogSheetsBatch.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW + 1_000)
  vi.stubGlobal('navigator', { onLine: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reported sequence
// ─────────────────────────────────────────────────────────────────────────────

describe('a draft reassigned away and then back', () => {
  it('archives the readings and empties the live row when the sheet moves away', async () => {
    // The clearing is not the bug — a shared tablet holds one row per sheet, so the next
    // operator must not inherit these values.
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle(OP2))

    expect(readingsOn(await getLogSheetByServerId(SERVER_ID))).toEqual({})
    expect(readingsOn((await getArchivedLogSheetsForUser(OP1))[0])).toEqual(READINGS)
  })

  it('shows the archived readings while the sheet belongs to somebody else', async () => {
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle(OP2))

    const archived = (await cardsFor(OP1)).find(c => c.localId.startsWith('archive:'))
    expect(readingsOn(archived)).toEqual(READINGS)
    expect(archived?.syncError).toBe('این کار به اپراتور دیگری واگذار شده است.')
  })

  /** The regression. Before the fix this returned one empty card and nothing else. */
  it('KEEPS showing them once the sheet is assigned back', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))

    await applyLogSheetBundle(bundle(OP1))

    const cards = await cardsFor(OP1)
    // The only surviving copy of the operator's readings must stay reachable.
    const archived = cards.find(c => c.localId.startsWith('archive:'))
    expect(archived).toBeDefined()
    expect(readingsOn(archived)).toEqual(READINGS)
  })

  it('offers the live sheet to work in as well, empty and ready', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))

    await applyLogSheetBundle(bundle(OP1))

    const live = (await cardsFor(OP1)).find(c => !c.localId.startsWith('archive:'))
    expect(live).toBeDefined()
    expect(readingsOn(live)).toEqual({})
    expect(live?.assigneeUserId).toBe(OP1)
  })

  it('does not copy the archived readings back into the live sheet', async () => {
    // Restoring automatically is NOT safe: the archive carries `locallyEditedAt`, so the values
    // would win the next merge and could bury whatever the other operator entered. An explicit
    // restore is designed in roadmap.md; this pins that it has not happened by accident.
    await saveLogSheet(localSheet());
    await applyLogSheetBundle(bundle(OP2))

    await applyLogSheetBundle(bundle(OP1))

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readingsOn(live)).toEqual({})
    expect(live?.entries[0].locallyEditedAt).toBeUndefined()
  })

  it('survives the sheet bouncing back and forth', async () => {
    await saveLogSheet(localSheet())

    for (let i = 0; i < 3; i++) {
      await applyLogSheetBundle(bundle(OP2))
      await applyLogSheetBundle(bundle(OP1))
    }

    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(1)
    const archived = (await cardsFor(OP1)).find(c => c.localId.startsWith('archive:'))
    expect(readingsOn(archived)).toEqual(READINGS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// What the change must NOT have broken
// ─────────────────────────────────────────────────────────────────────────────

describe('cases the old rule existed for', () => {
  /**
   * The reason the rule was written: a revoke that turns out to be wrong.
   *
   * The live row still holds the operator's values, so it is the real copy and the archive is
   * noise. Showing both would give them two cards for one sheet and no way to tell which is live.
   */
  it('hides the archive when the live row still holds the work', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))          // archive taken, row cleared
    // The row comes back with its values — the shape a false revoke leaves behind.
    const live = (await getLogSheetByServerId(SERVER_ID))!
    await saveLogSheet({
      ...live,
      assigneeUserId: OP1,
      localOwnerUserId: OP1,
      entries: [filledEntry()]
    })

    const cards = await cardsFor(OP1)

    expect(cards.filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
    expect(cards).toHaveLength(1)
  })

  /**
   * A delivered submission still drops its archive, even though its row was emptied earlier.
   *
   * There is nothing left to recover once the server has the work, and keeping the snapshot
   * would show the operator a permanent duplicate of their own completed round.
   */
  it('removes the archive once the sheet is submitted and synced', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))
    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(1)

    const live = (await getLogSheetByServerId(SERVER_ID))!
    await saveLogSheet({
      ...live,
      assigneeUserId: OP1,
      localOwnerUserId: OP1,
      status: 'submitted',
      syncStatus: 'synced'
    })

    const cards = await cardsFor(OP1)

    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(0)
    expect(cards.filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })

  /** A shared tablet: the other operator must see none of this. */
  it('shows nothing of operator 1’s work to operator 2', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))

    const theirCards = await cardsFor(OP2)

    expect(theirCards.filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
    expect(theirCards.every(c => readingsOn(c).temp === undefined)).toBe(true)
  })

  it('shows nothing at all without a session user', async () => {
    await saveLogSheet(localSheet())
    await applyLogSheetBundle(bundle(OP2))

    expect(await loadLogSheetsForSessionUser(await db.logSheets.toArray(), null, new Set()))
        .toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Neighbouring sync states, so the fix is not read as "always show the archive"
// ─────────────────────────────────────────────────────────────────────────────

describe('the archive is only taken when there is work to archive', () => {
  it('takes no archive when the sheet moves away empty', async () => {
    await saveLogSheet(localSheet({ entries: [
      { assetId: '7', assetName: 'پمپ ۱', subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1', classId: '2', formData: {} }
    ] }))

    await applyLogSheetBundle(bundle(OP2))

    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(0)
    expect((await cardsFor(OP1)).filter(c => c.localId.startsWith('archive:'))).toHaveLength(0)
  })

  it('leaves an unsent completion entirely alone — only the submit outcome may resolve it', async () => {
    // Unchanged rule, re-pinned here: a bundle refresh must never touch a row that is
    // `submitted` + `pending`, whatever the server says about who owns the sheet now.
    await saveLogSheet(localSheet({ status: 'submitted', syncStatus: 'pending' }))

    await applyLogSheetBundle(bundle(OP2))

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(live?.status).toBe('submitted')
    expect(live?.syncStatus).toBe('pending')
    expect(readingsOn(live)).toEqual(READINGS)
  })

  it('keeps the draft when the sheet is released to the pool rather than reassigned', async () => {
    // A null server assignee is not a mismatch: nobody else has taken it, so there is nothing
    // to protect the next operator from and the draft stays where it is.
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle(null, 'PENDING'))

    expect(readingsOn(await getLogSheetByServerId(SERVER_ID))).toEqual(READINGS)
    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(0)
  })

  it('keeps the draft through an ordinary refresh that changes nothing', async () => {
    await saveLogSheet(localSheet())

    await applyLogSheetBundle(bundle(OP1))
    await applyLogSheetBundle(bundle(OP1))

    expect(readingsOn(await getLogSheetByServerId(SERVER_ID))).toEqual(READINGS)
    expect(await getArchivedLogSheetsForUser(OP1)).toHaveLength(0)
    expect((await cardsFor(OP1))).toHaveLength(1)
  })
})
