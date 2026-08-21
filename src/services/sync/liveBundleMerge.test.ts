import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import type { LogSheetBundleDto } from '@/services/api'
import type { LogSheet, LogSheetEntryData } from '@/types'

/**
 * The merge, driven over two **real** bundles captured from a running server.
 *
 * <h2>Why this exists next to the fixture-based tests</h2>
 *
 * Every other test in this directory builds its bundle by hand. That is the right way to cover
 * behaviour, and it shares one blind spot with the code under test: if the DTO the server
 * actually sends has drifted from the shape the fixtures assume, all of them stay green and none
 * of them is about production any more. This one takes JSON the server produced and runs the
 * shipping path over it — `applyLogSheetBundle`, a real Dexie database, real 47-entry payloads.
 *
 * <h2>Skipped unless you point it at two captures</h2>
 *
 * It needs a running backend, so it cannot be part of an ordinary `npm test`. Capture the two
 * bundles either side of an edit made on the web, then:
 *
 * <pre>
 *   LIVE_BUNDLE_BEFORE=/path/before.json \
 *   LIVE_BUNDLE_AFTER=/path/after.json \
 *   LIVE_BUNDLE_ASSET=2 \
 *   npx vitest run src/services/sync/liveBundleMerge.test.ts
 * </pre>
 *
 * Without those it reports as skipped rather than passing, so it can never be mistaken for
 * coverage it did not provide.
 */

const BEFORE_PATH = process.env.LIVE_BUNDLE_BEFORE
const AFTER_PATH = process.env.LIVE_BUNDLE_AFTER
const ASSET_ID = process.env.LIVE_BUNDLE_ASSET

const enabled = Boolean(BEFORE_PATH && AFTER_PATH && ASSET_ID)

describe.skipIf(!enabled)('the merge over real server bundles', () => {
  let before: LogSheetBundleDto
  let after: LogSheetBundleDto
  let sessionUserId: string
  let serverId: string
  let serverBefore: Record<string, unknown>
  let serverAfter: Record<string, unknown>

  beforeAll(async () => {
    before = JSON.parse(readFileSync(BEFORE_PATH!, 'utf8')) as LogSheetBundleDto
    after = JSON.parse(readFileSync(AFTER_PATH!, 'utf8')) as LogSheetBundleDto
    sessionUserId = String(before.sheet.assigneeUserId)
    serverId = String(before.sheet.id)
    serverBefore = entryIn(before).formData as Record<string, unknown>
    serverAfter = entryIn(after).formData as Record<string, unknown>
    if (!db.isOpen()) await db.open()
  })

  function entryIn(bundle: LogSheetBundleDto) {
    const found = bundle.entries.find(e => String(e.assetId) === ASSET_ID)
    if (!found) throw new Error(`asset ${ASSET_ID} is not in the bundle`)
    return found
  }

  function localEntry(sheet: LogSheet | undefined): LogSheetEntryData | undefined {
    return sheet?.entries.find(e => e.assetId === ASSET_ID)
  }

  /** A device that has this sheet assigned and has never synced it. */
  async function freshDevice(): Promise<void> {
    await db.logSheets.clear()
    await db.syncMeta.clear()
    await db.syncMeta.put({ key: 'sessionUserId', value: Number(sessionUserId) })
    await saveLogSheet({
      id: 'live-1',
      localId: 'live-1',
      serverId,
      templateId: String(before.sheet.templateId),
      templateName: before.sheet.templateName,
      status: 'draft',
      syncStatus: 'pending',
      serverStatus: before.sheet.status,
      assigneeUserId: sessionUserId,
      localOwnerUserId: sessionUserId,
      dueAt: before.sheet.dueAt,
      entries: [],
      createdAt: before.sheet.createdAt,
      updatedAt: before.sheet.updatedAt
    } as unknown as LogSheet)
  }

  it('the first sync leaves the server value and no marker', async () => {
    await freshDevice()

    await applyLogSheetBundle(before)

    const entry = localEntry(await getLogSheet('live-1'))
    expect(entry?.formData).toEqual(serverBefore)
    expect(entry?.locallyEditedAt)
      .toBeUndefined()
  })

  it('a correction made on the web lands on the next sync', async () => {
    // The reported bug, over real payloads: the device holds a value it was sent, and must not
    // treat that as a reason to ignore a newer one.
    await freshDevice()
    await applyLogSheetBundle(before)

    await applyLogSheetBundle(after)

    expect(localEntry(await getLogSheet('live-1'))?.formData).toEqual(serverAfter)
  })

  it('an edit made on the tablet survives that same correction', async () => {
    await freshDevice()
    await applyLogSheetBundle(before)
    const held = (await getLogSheet('live-1'))!
    await saveLogSheet({
      ...held,
      entries: held.entries.map(e =>
        e.assetId === ASSET_ID
          ? applyOperatorEntrySave(e, { ...e.formData, __live: 'operator' }, 'manual', Date.now())
          : e)
    })

    await applyLogSheetBundle(after)

    const entry = localEntry(await getLogSheet('live-1'))
    expect(entry?.formData.__live).toBe('operator')
    expect(typeof entry?.locallyEditedAt).toBe('number')
  })

  it('every other entry of the sheet still tracks the server', async () => {
    // The counterweight to the test above: "the device keeps its edit" must not quietly mean
    // "the device keeps everything". On a 47-asset sheet that difference is the whole feature.
    await freshDevice()
    await applyLogSheetBundle(before)
    await applyLogSheetBundle(after)

    const local = await getLogSheet('live-1')
    const drifted = (local?.entries ?? []).filter(entry => {
      const server = after.entries.find(e => String(e.assetId) === entry.assetId)
      return JSON.stringify(entry.formData) !== JSON.stringify(server?.formData ?? {})
    })

    expect(drifted.map(e => e.assetId)).toEqual([])
  })
})
