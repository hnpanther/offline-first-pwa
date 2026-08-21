import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { loadLogSheetsForSessionUser } from '@/services/auth/sessionContext'
import { getArchivedLogSheetsForUser } from '@/services/storage/logSheetArchive'
import { buildRestorePlan, restoreArchivedEntries } from '@/services/storage/restoreArchivedWork'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import { toIdString } from '@/utils/ids'
import type { LogSheetBundleDto } from '@/services/api'
import type { LocalAttachment, LogSheet } from '@/types'

vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * The reassign round trip, over **real** bundles captured from a running server.
 *
 * <h2>Why this exists next to `reassignRoundTrip.test.ts`</h2>
 *
 * That file builds its bundles by hand, which is the right way to cover behaviour and shares one
 * blind spot with the code under test: if the DTO the server actually sends has drifted from the
 * shape the fixtures assume, every assertion stays green and none of them is about production.
 * This one runs the shipping path over JSON the server produced — a real 47-asset sheet, real
 * assignee ids, real timestamps.
 *
 * <h2>Skipped unless pointed at three captures</h2>
 *
 * It needs a running backend, so it cannot be part of an ordinary `npm test`. Capture the same
 * open sheet three times — assigned to the operator, reassigned to somebody else, assigned back —
 * then:
 *
 * <pre>
 *   LIVE_RA_BEFORE=before.json \
 *   LIVE_RA_AWAY=away.json \
 *   LIVE_RA_BACK=back.json \
 *   npx vitest run src/services/sync/liveReassignRoundTrip.test.ts
 * </pre>
 *
 * Without them it reports as skipped rather than passing, so it can never be mistaken for
 * coverage it did not provide.
 */

const BEFORE = process.env.LIVE_RA_BEFORE
const AWAY = process.env.LIVE_RA_AWAY
const BACK = process.env.LIVE_RA_BACK
const enabled = Boolean(BEFORE && AWAY && BACK)

describe.skipIf(!enabled)('reassign round trip over real server bundles', () => {
  let before: LogSheetBundleDto
  let away: LogSheetBundleDto
  let back: LogSheetBundleDto
  let operator: string
  let other: string
  let serverId: string
  let assetId: string

  const READINGS = { __live: 'operator-1' }
  /** A key no class declares, so the restore is exercised without depending on a real schema. */
  const PHOTO_FIELD = '__live_photo'

  beforeAll(async () => {
    before = JSON.parse(readFileSync(BEFORE!, 'utf8')) as LogSheetBundleDto
    away = JSON.parse(readFileSync(AWAY!, 'utf8')) as LogSheetBundleDto
    back = JSON.parse(readFileSync(BACK!, 'utf8')) as LogSheetBundleDto
    operator = String(before.sheet.assigneeUserId)
    other = String(away.sheet.assigneeUserId)
    serverId = String(before.sheet.id)
    assetId = String(before.entries[0].assetId)

    expect(operator).not.toBe(other)
    expect(String(back.sheet.assigneeUserId)).toBe(operator)
    if (!db.isOpen()) await db.open()
  })

  /** A device holding this sheet with the operator's own unsent readings on one asset. */
  async function deviceWithLocalWork(): Promise<void> {
    await db.logSheets.clear()
    await db.logSheetUserArchives.clear()
    await db.syncMeta.clear()
    await db.syncMeta.put({ key: 'sessionUserId', value: Number(operator) })

    await saveLogSheet({
      id: 'live-1',
      localId: 'live-1',
      serverId,
      templateId: String(before.sheet.templateId),
      templateName: before.sheet.templateName,
      status: 'draft',
      syncStatus: 'pending',
      serverStatus: before.sheet.status,
      assigneeUserId: operator,
      localOwnerUserId: operator,
      dueAt: before.sheet.dueAt,
      entries: [],
      createdAt: before.sheet.createdAt,
      updatedAt: before.sheet.updatedAt
    } as unknown as LogSheet)

    await applyLogSheetBundle(before)

    const held = (await getLogSheetByServerId(serverId))!
    await saveLogSheet({
      ...held,
      entries: held.entries.map(e =>
        e.assetId === assetId
          ? applyOperatorEntrySave(e, { ...e.formData, ...READINGS }, 'manual', Date.now())
          : e)
    })
  }

  /**
   * The same device, plus two photographs on the asset the operator filled.
   *
   * <p>Media is the half of the round trip that could never be worked around: readings can be
   * retyped, a file whose reference the clear dropped cannot be. The rows are real Dexie rows —
   * only the bundles come from the server — because the server never sees a local attachment id.
   */
  async function deviceWithLocalWorkAndPhotos(): Promise<void> {
    await deviceWithLocalWork()

    const held = (await getLogSheetByServerId(serverId))!
    await db.attachments.bulkPut(
      ['live-p1', 'live-p2'].map((id, i) => ({
        id,
        logSheetLocalId: held.localId,
        logSheetServerId: serverId,
        assetId,
        fieldKey: PHOTO_FIELD,
        kind: 'IMAGE',
        mimeType: 'image/webp',
        sizeBytes: 1024,
        blob: new Blob(['x'], { type: 'image/webp' }),
        syncStatus: 'pending',
        createdAt: Date.now() + i
      })) as LocalAttachment[]
    )
    await saveLogSheet({
      ...held,
      entries: held.entries.map(e =>
        e.assetId === assetId
          ? applyOperatorEntrySave(
              e,
              { ...e.formData, [PHOTO_FIELD]: buildAttachmentRef(['live-p1', 'live-p2']) },
              'manual',
              Date.now()
            )
          : e)
    })
  }

  function readingsOn(sheet: LogSheet | undefined): Record<string, unknown> {
    return sheet?.entries.find(e => e.assetId === assetId)?.formData ?? {}
  }

  async function cards(): Promise<LogSheet[]> {
    return loadLogSheetsForSessionUser(await db.logSheets.toArray(), operator, new Set())
  }

  it('archives the readings when the real bundle hands the sheet to somebody else', async () => {
    await deviceWithLocalWork()

    await applyLogSheetBundle(away)

    expect(readingsOn(await getLogSheetByServerId(serverId)).__live).toBeUndefined()
    const archived = await getArchivedLogSheetsForUser(operator)
    expect(archived).toHaveLength(1)
    expect(readingsOn(archived[0]).__live).toBe('operator-1')
  })

  it('still shows them once the real bundle hands it back', async () => {
    // The reported bug, over real payloads: before the fix this list held one empty card.
    await deviceWithLocalWork()
    await applyLogSheetBundle(away)

    await applyLogSheetBundle(back)

    const archivedCard = (await cards()).find(c => c.localId.startsWith('archive:'))
    expect(archivedCard).toBeDefined()
    expect(readingsOn(archivedCard).__live).toBe('operator-1')
  })

  it('offers the live sheet as well, empty and assigned back to the operator', async () => {
    await deviceWithLocalWork()
    await applyLogSheetBundle(away)

    await applyLogSheetBundle(back)

    const live = (await cards()).find(c => !c.localId.startsWith('archive:'))
    expect(live).toBeDefined()
    expect(readingsOn(live).__live).toBeUndefined()
    expect(live?.assigneeUserId).toBe(operator)
  })

  it('leaves every other asset of the real sheet tracking the server', async () => {
    // The counterweight: "the archive stays visible" must not mean the live row kept stale data.
    await deviceWithLocalWork()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)

    const live = (await getLogSheetByServerId(serverId))!
    const drifted = live.entries.filter(entry => {
      const server = back.entries.find(e => String(e.assetId) === entry.assetId)
      return JSON.stringify(entry.formData) !== JSON.stringify(server?.formData ?? {})
    })

    expect(drifted.map(e => e.assetId)).toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────
  // The explicit restore, over the same real payloads
  // ───────────────────────────────────────────────────────────────────────

  it('offers the archived readings for restore once the real bundle hands the sheet back', async () => {
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)

    const plan = await buildRestorePlan(serverId, operator)

    expect(plan).not.toBeNull()
    const offered = plan!.assets.find(a => a.assetId === toIdString(assetId))
    expect(offered).toBeDefined()
    expect(offered!.conflict).toBe(false)
    expect(offered!.attachmentIds).toEqual(['live-p1', 'live-p2'])
  })

  it('writes the readings and the photo references back into the real live sheet', async () => {
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)

    const outcome = await restoreArchivedEntries(serverId, operator, [toIdString(assetId)])

    expect(outcome.refusal).toBeUndefined()
    const live = await getLogSheetByServerId(serverId)
    expect(readingsOn(live).__live).toBe('operator-1')
    expect(attachmentIdsOf(readingsOn(live)[PHOTO_FIELD])).toEqual(['live-p1', 'live-p2'])
  })

  it('leaves every other asset of the real sheet still tracking the server', async () => {
    // A restore touches the assets the operator chose and nothing else — on a 47-asset sheet
    // that distinction is the difference between a recovery and a corruption.
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)

    await restoreArchivedEntries(serverId, operator, [toIdString(assetId)])

    const live = (await getLogSheetByServerId(serverId))!
    const drifted = live.entries.filter(entry => {
      if (entry.assetId === assetId) return false
      const server = back.entries.find(e => String(e.assetId) === entry.assetId)
      return JSON.stringify(entry.formData) !== JSON.stringify(server?.formData ?? {})
    })

    expect(drifted.map(e => e.assetId)).toEqual([])
  })

  it('keeps the restored values through the next real bundle', async () => {
    // Why `locallyEditedAt` is stamped at restore time rather than carried from the archive.
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)
    await restoreArchivedEntries(serverId, operator, [toIdString(assetId)])

    await applyLogSheetBundle(back)

    const live = await getLogSheetByServerId(serverId)
    expect(readingsOn(live).__live).toBe('operator-1')
    expect(attachmentIdsOf(readingsOn(live)[PHOTO_FIELD])).toEqual(['live-p1', 'live-p2'])
  })

  it('moves no attachment file', async () => {
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)
    const before = await db.attachments.count()

    await restoreArchivedEntries(serverId, operator, [toIdString(assetId)])

    expect(await db.attachments.count()).toBe(before)
  })

  it('refuses when a real bundle has already handed the sheet on again', async () => {
    await deviceWithLocalWorkAndPhotos()
    await applyLogSheetBundle(away)
    await applyLogSheetBundle(back)

    await applyLogSheetBundle(away)
    const outcome = await restoreArchivedEntries(serverId, operator, [toIdString(assetId)])

    expect(outcome.refusal).toBe('not-your-work')
    expect(readingsOn(await getLogSheetByServerId(serverId)).__live).toBeUndefined()
    expect(await getArchivedLogSheetsForUser(operator)).toHaveLength(1)
  })
})
