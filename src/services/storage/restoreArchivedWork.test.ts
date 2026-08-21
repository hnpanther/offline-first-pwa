import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { archiveLogSheetForUser } from '@/services/storage/logSheetArchive'
import { buildRestorePlan, restoreArchivedEntries } from '@/services/storage/restoreArchivedWork'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { toIdString } from '@/utils/ids'
import type { LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'

vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * Restoring an archived round into the live sheet.
 *
 * <h2>What this is for</h2>
 *
 * A sheet reassigned away is archived and the live row cleared; if it comes back, the operator
 * could see their readings but had to retype them, and their photographs were unreachable
 * altogether — the files were on the device but the references had been cleared out of
 * `formData`. This is the explicit restore: the operator picks assets, with both versions in
 * front of them, and the chosen ones are written back.
 *
 * <h2>The invariant the attachment half is tested against</h2>
 *
 * > For every (asset, field) a restore writes, the ids in `formData` are **exactly** the ids of
 * > the attachment rows this device holds for that (sheet, asset, field), excluding rows queued
 * > for deletion — deduplicated, and never an id that resolves to nothing.
 *
 * `theWrittenReferencesMatchTheDeviceExactly` checks that directly, and the cases around it show
 * each way it could be violated: a file the archive never knew about, an id whose row is gone, a
 * duplicate, a row queued for deletion, and a field with nothing left at all.
 */

const OP1 = '7'
const OP2 = '8'
const SERVER_ID = '55'
const NOW = 1_700_000_000_000
const LATER = NOW + 500_000

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function entry(assetId: string, formData: Record<string, unknown>,
               overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId,
    assetName: `پمپ ${assetId}`,
    subFunctionCode: `SF-${assetId}`,
    subFunctionTag: `TAG-${assetId}`,
    classId: '2',
    formData,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    ...overrides
  }
}

function sheet(entries: LogSheetEntryData[], overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    assigneeUserId: OP1,
    localOwnerUserId: OP1,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    entries,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function attachment(id: string, assetId: string, fieldKey: string,
                    overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id,
    logSheetLocalId: 'local-1',
    logSheetServerId: SERVER_ID,
    assetId,
    fieldKey,
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 100,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'pending',
    createdAt: NOW,
    ...overrides
  } as LocalAttachment
}

function fieldDef(
  key: string,
  label: string,
  order: number,
  overrides: Partial<FieldDefinition> = {}
): FieldDefinition {
  return {
    id: `fd-${key}`,
    classId: '2',
    key,
    label,
    dataType: 'number',
    required: false,
    order,
    updatedAt: NOW,
    ...overrides
  } as FieldDefinition
}

/**
 * Puts the device in the state the bug leaves behind: the operator's work archived, the live
 * row cleared, and every attachment file still present.
 */
async function archivedAndCleared(
  archivedEntries: LogSheetEntryData[],
  liveEntries: LogSheetEntryData[] = archivedEntries.map(e => entry(e.assetId, {})),
  liveOverrides: Partial<LogSheet> = {}
): Promise<void> {
  await archiveLogSheetForUser(sheet(archivedEntries), OP1)
  await saveLogSheet(sheet(liveEntries, liveOverrides))
}

function fieldIds(s: LogSheet | undefined, assetId: string, fieldKey: string): string[] {
  const e = s?.entries.find(x => toIdString(x.assetId) === assetId)
  return attachmentIdsOf(e?.formData[fieldKey])
}

function readings(s: LogSheet | undefined, assetId: string): Record<string, unknown> {
  return s?.entries.find(x => toIdString(x.assetId) === assetId)?.formData ?? {}
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.logSheetUserArchives.clear()
  await db.attachments.clear()
  await db.fieldDefinitions.clear()
  await db.syncMeta.clear()
})

// ─────────────────────────────────────────────────────────────────────────────
// The plan the operator is shown
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRestorePlan', () => {
  it('offers each asset the archive holds readings for', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }), entry('2', { temp: 7 })])

    const plan = await buildRestorePlan(SERVER_ID, OP1)

    expect(plan?.assets.map(a => a.assetId)).toEqual(['1', '2'])
    expect(plan?.liveLocalId).toBe('local-1')
  })

  it('shows both versions so the operator can compare them', async () => {
    await archivedAndCleared(
      [entry('1', { temp: 42 })],
      [entry('1', { temp: 99 })]
    )

    const asset = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0]

    expect(asset.mine).toEqual({ temp: 42 })
    expect(asset.current).toEqual({ temp: 99 })
    expect(asset.conflict).toBe(true)
  })

  it('marks an asset nobody else touched as unconflicted', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })])

    expect((await buildRestorePlan(SERVER_ID, OP1))!.assets[0].conflict).toBe(false)
  })

  it('skips assets the archive has nothing for', async () => {
    await archivedAndCleared(
      [entry('1', { temp: 42 }), entry('2', {})],
      [entry('1', {}), entry('2', {})]
    )

    expect((await buildRestorePlan(SERVER_ID, OP1))!.assets.map(a => a.assetId)).toEqual(['1'])
  })

  it('returns null when there is no archive', async () => {
    await saveLogSheet(sheet([entry('1', {})]))

    expect(await buildRestorePlan(SERVER_ID, OP1)).toBeNull()
  })

  it('returns null when the sheet is not this user’s work', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], undefined,
      { assigneeUserId: OP2, localOwnerUserId: undefined })

    expect(await buildRestorePlan(SERVER_ID, OP1)).toBeNull()
  })

  it('returns null once the sheet has been submitted', async () => {
    // A delivered round is not something to paste older readings into.
    await archivedAndCleared([entry('1', { temp: 42 })], undefined, { status: 'submitted' })

    expect(await buildRestorePlan(SERVER_ID, OP1)).toBeNull()
  })

  it('names the attachment ids that no longer resolve, so the loss is not silent', async () => {
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['gone-1', 'kept-1']) })])
    await db.attachments.put(attachment('kept-1', '1', 'Pic'))

    const asset = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0]

    expect(asset.missingAttachmentIds).toEqual(['gone-1'])
    expect(asset.attachmentIds).toEqual(['kept-1'])
  })

  it('does not offer an asset whose only content was media that is gone', async () => {
    // Restoring it would write an empty entry and call it a recovery.
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['gone-1']) })])

    expect(await buildRestorePlan(SERVER_ID, OP1)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Restoring readings
// ─────────────────────────────────────────────────────────────────────────────

describe('restoreArchivedEntries — readings', () => {
  it('writes the chosen asset back into the live sheet', async () => {
    await archivedAndCleared([entry('1', { temp: 42, note: 'صدای غیرعادی' })])

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(outcome.restoredAssetIds).toEqual(['1'])
    expect(readings(await getLogSheetByServerId(SERVER_ID), '1'))
        .toEqual({ temp: 42, note: 'صدای غیرعادی' })
  })

  it('leaves the assets the operator did not choose alone', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }), entry('2', { temp: 7 })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readings(live, '1')).toEqual({ temp: 42 })
    expect(readings(live, '2')).toEqual({})
  })

  it('stamps locallyEditedAt at restore time, not the archived value', async () => {
    // The opinion is being formed now, by somebody who has just compared both versions. Carrying
    // the old stamp would claim the edit predates values the server has since sent.
    await archivedAndCleared([entry('1', { temp: 42 }, { locallyEditedAt: NOW - 999_999 })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(live?.entries[0].locallyEditedAt).toBe(LATER)
  })

  it('keeps the live sheet’s own createdAt/updatedAt', async () => {
    // These two are the version this device last saw, echoed back on submit and compared by the
    // server. Replacing them with the archive's would report a base the device no longer holds.
    await archivedAndCleared(
      [entry('1', { temp: 42 }, { createdAt: 111, updatedAt: 222 })],
      [entry('1', {}, { createdAt: 999, updatedAt: 1_000 })]
    )

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(live?.entries[0].createdAt).toBe(999)
    expect(live?.entries[0].updatedAt).toBe(1_000)
  })

  it('carries filledVia, because the server never sends it back', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }, { filledVia: 'manual' })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect((await getLogSheetByServerId(SERVER_ID))?.entries[0].filledVia).toBe('manual')
  })

  it('clears filledByName, exactly as an ordinary save does', async () => {
    // Attribution is the server's decision; it re-stamps on the next bundle.
    await archivedAndCleared([entry('1', { temp: 42 }, { filledByName: 'اپراتور قبلی' })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect((await getLogSheetByServerId(SERVER_ID))?.entries[0].filledByName).toBeUndefined()
  })

  it('replaces a conflicting value, since the operator chose that asset', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], [entry('1', { temp: 99 })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(readings(await getLogSheetByServerId(SERVER_ID), '1')).toEqual({ temp: 42 })
  })

  it('does not blank a field the other operator answered and the archive left empty', async () => {
    // The archive's own blank is not a reading. Writing it over somebody's value would be a
    // deletion dressed up as a restore.
    await archivedAndCleared(
      [entry('1', { temp: 42, note: '' })],
      [entry('1', { note: 'مقدار اپراتور دوم' })]
    )

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(readings(await getLogSheetByServerId(SERVER_ID), '1'))
        .toEqual({ temp: 42, note: 'مقدار اپراتور دوم' })
  })

  it('keeps a field the archive says nothing about', async () => {
    await archivedAndCleared(
      [entry('1', { temp: 42 })],
      [entry('1', { pressure: 3 })]
    )

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(readings(await getLogSheetByServerId(SERVER_ID), '1'))
        .toEqual({ pressure: 3, temp: 42 })
  })

  it('restores a reading of zero', async () => {
    await archivedAndCleared([entry('1', { temp: 0 })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(readings(await getLogSheetByServerId(SERVER_ID), '1')).toEqual({ temp: 0 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Restoring attachments — nothing extra, nothing missing
// ─────────────────────────────────────────────────────────────────────────────

describe('restoreArchivedEntries — attachments', () => {
  /** The invariant, checked directly. */
  it('theWrittenReferencesMatchTheDeviceExactly', async () => {
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['a', 'b']) })])
    await db.attachments.bulkPut([
      attachment('a', '1', 'Pic'),
      attachment('b', '1', 'Pic'),
      attachment('c', '1', 'Pic')          // captured on this tablet, unknown to the archive
    ])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const written = fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')
    const onDevice = (await db.attachments.toArray())
      .filter(r => !r.pendingDelete && toIdString(r.assetId) === '1' && r.fieldKey === 'Pic')
      .map(r => r.id)
    expect([...written].sort()).toEqual([...onDevice].sort())
  })

  it('brings the operator’s photographs back', async () => {
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['a']) })])
    await db.attachments.put(attachment('a', '1', 'Pic'))

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')).toEqual(['a'])
  })

  it('drops an id whose file is no longer on the device', async () => {
    // A dangling reference renders as a broken slot and misleads the field counter.
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['gone', 'a']) })])
    await db.attachments.put(attachment('a', '1', 'Pic'))

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')).toEqual(['a'])
  })

  it('keeps a file the other operator captured on this tablet', async () => {
    // Dropping a reference does not delete the file, it hides it — and hiding somebody's
    // photograph is the failure this codebase has already paid for once.
    await archivedAndCleared(
      [entry('1', { Pic: buildAttachmentRef(['mine']) })],
      [entry('1', { Pic: buildAttachmentRef(['theirs']) })]
    )
    await db.attachments.bulkPut([
      attachment('mine', '1', 'Pic'),
      attachment('theirs', '1', 'Pic', { createdAt: NOW + 1 })
    ])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic'))
        .toEqual(['mine', 'theirs'])
  })

  it('never writes the same id twice', async () => {
    await archivedAndCleared(
      [entry('1', { Pic: buildAttachmentRef(['a', 'a']) })],
      [entry('1', { Pic: buildAttachmentRef(['a']) })]
    )
    await db.attachments.put(attachment('a', '1', 'Pic'))

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')).toEqual(['a'])
  })

  it('ignores a file already queued for deletion', async () => {
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['a', 'doomed']) })])
    await db.attachments.bulkPut([
      attachment('a', '1', 'Pic'),
      attachment('doomed', '1', 'Pic', { pendingDelete: true })
    ])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')).toEqual(['a'])
  })

  it('omits the field entirely when nothing survived, rather than writing an empty reference', async () => {
    // `{type:'attachment', ids:[]}` is a key that means "nothing" — the contamination shape.
    await archivedAndCleared([entry('1', { temp: 42, Pic: buildAttachmentRef(['gone']) })])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const restored = readings(await getLogSheetByServerId(SERVER_ID), '1')
    expect(restored).toEqual({ temp: 42 })
    expect('Pic' in restored).toBe(false)
  })

  it('does not borrow a file from another asset or another field', async () => {
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['a']) })])
    await db.attachments.bulkPut([
      attachment('a', '1', 'Pic'),
      attachment('other-asset', '2', 'Pic'),
      attachment('other-field', '1', 'Audio', { kind: 'AUDIO' })
    ])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(fieldIds(await getLogSheetByServerId(SERVER_ID), '1', 'Pic')).toEqual(['a'])
  })

  it('restores media and readings on the same asset together', async () => {
    await archivedAndCleared([entry('1', { temp: 42, Pic: buildAttachmentRef(['a']) })])
    await db.attachments.put(attachment('a', '1', 'Pic'))

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const restored = readings(await getLogSheetByServerId(SERVER_ID), '1')
    expect(restored.temp).toBe(42)
    expect(attachmentIdsOf(restored.Pic)).toEqual(['a'])
  })

  it('handles several fields of different kinds on one asset', async () => {
    await archivedAndCleared([entry('1', {
      Pic: buildAttachmentRef(['img']),
      Audio: buildAttachmentRef(['snd'])
    })])
    await db.attachments.bulkPut([
      attachment('img', '1', 'Pic'),
      attachment('snd', '1', 'Audio', { kind: 'AUDIO' })
    ])

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(fieldIds(live, '1', 'Pic')).toEqual(['img'])
    expect(fieldIds(live, '1', 'Audio')).toEqual(['snd'])
  })

  it('moves no file and deletes none', async () => {
    // A restore is a reference change. If it ever starts touching the store, a shared tablet
    // loses somebody's evidence.
    await archivedAndCleared([entry('1', { Pic: buildAttachmentRef(['a']) })])
    await db.attachments.bulkPut([
      attachment('a', '1', 'Pic'),
      attachment('untouched', '2', 'Pic')
    ])
    const before = await db.attachments.toArray()

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const after = await db.attachments.toArray()
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    expect(after.every(r => r.syncStatus === 'pending')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The archive afterwards
// ─────────────────────────────────────────────────────────────────────────────

describe('what happens to the archive', () => {
  it('drops it once every restorable asset has been restored', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }), entry('2', { temp: 7 })])

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['1', '2'], LATER)

    expect(outcome.archiveCleared).toBe(true)
    expect(await db.logSheetUserArchives.toArray()).toHaveLength(0)
  })

  it('keeps it after a partial restore, so the rest stays reachable', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }), entry('2', { temp: 7 })])

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    expect(outcome.archiveCleared).toBe(false)
    expect(await db.logSheetUserArchives.toArray()).toHaveLength(1)
  })

  it('lets a second pass finish the job', async () => {
    await archivedAndCleared([entry('1', { temp: 42 }), entry('2', { temp: 7 })])
    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['2'], LATER)

    expect(outcome.restoredAssetIds).toEqual(['2'])
    expect(outcome.archiveCleared).toBe(true)
    const live = await getLogSheetByServerId(SERVER_ID)
    expect(readings(live, '1')).toEqual({ temp: 42 })
    expect(readings(live, '2')).toEqual({ temp: 7 })
  })

  it('is idempotent — restoring the same asset twice changes nothing the second time', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })])
    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)
    const afterFirst = await getLogSheetByServerId(SERVER_ID)

    const second = await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER + 1)

    expect(second.refusal).toBe('no-archive')
    expect(readings(await getLogSheetByServerId(SERVER_ID), '1'))
        .toEqual(readings(afterFirst, '1'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

describe('restoreArchivedEntries refuses', () => {
  it('when there is no archive', async () => {
    await saveLogSheet(sheet([entry('1', {})]))

    expect((await restoreArchivedEntries(SERVER_ID, OP1, ['1'])).refusal).toBe('no-archive')
  })

  it('when the live sheet is gone', async () => {
    await archiveLogSheetForUser(sheet([entry('1', { temp: 42 })]), OP1)

    expect((await restoreArchivedEntries(SERVER_ID, OP1, ['1'])).refusal).toBe('no-live-sheet')
  })

  it('when the sheet now belongs to somebody else', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], undefined,
      { assigneeUserId: OP2, localOwnerUserId: undefined })

    expect((await restoreArchivedEntries(SERVER_ID, OP1, ['1'])).refusal).toBe('not-your-work')
  })

  it('when the sheet has already been submitted', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], undefined, { status: 'submitted' })

    expect((await restoreArchivedEntries(SERVER_ID, OP1, ['1'])).refusal)
        .toBe('sheet-not-editable')
  })

  it('and writes nothing when it refuses', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], undefined,
      { assigneeUserId: OP2, localOwnerUserId: undefined })

    await restoreArchivedEntries(SERVER_ID, OP1, ['1'])

    expect(readings(await getLogSheetByServerId(SERVER_ID), '1')).toEqual({})
    expect(await db.logSheetUserArchives.toArray()).toHaveLength(1)
  })

  it('quietly does nothing for an asset id that was never offered', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })])

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['999'], LATER)

    expect(outcome.restoredAssetIds).toEqual([])
    expect(outcome.archiveCleared).toBe(false)
    expect(readings(await getLogSheetByServerId(SERVER_ID), '1')).toEqual({})
  })

  it('ignores an empty selection', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })])

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [], LATER)

    expect(outcome.restoredAssetIds).toEqual([])
    expect(await db.logSheetUserArchives.toArray()).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The per-field diff — what the operator actually reads before deciding
// ─────────────────────────────────────────────────────────────────────────────

describe('the field-level diff', () => {
  it('labels each field the way the class does', async () => {
    // A dialog that says `temp_out` asks the operator to decide about something they have never
    // seen; the fill page has always shown them دمای خروجی.
    await db.fieldDefinitions.bulkPut([
      fieldDef('temp_out', 'دمای خروجی', 0, { unit: '°C' })
    ])
    await archivedAndCleared([entry('1', { temp_out: 42 })])

    const field = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields[0]

    expect(field.key).toBe('temp_out')
    expect(field.label).toBe('دمای خروجی')
    expect(field.unit).toBe('°C')
  })

  it('prefers the sheet own frozen schema over the shared table', async () => {
    // Same precedence as the fill page. A class edited after this sheet was issued must not
    // relabel a round that was filled against the older definition.
    await db.fieldDefinitions.bulkPut([fieldDef('temp_out', 'برچسب جدید', 0)])
    await archiveLogSheetForUser(sheet([entry('1', { temp_out: 42 })]), OP1)
    await saveLogSheet(
      sheet([entry('1', {})], {
        fieldDefinitions: [fieldDef('temp_out', 'برچسب قدیمی', 0)]
      } as Partial<LogSheet>)
    )

    const field = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields[0]

    expect(field.label).toBe('برچسب قدیمی')
  })

  it('falls back to the raw key for a field the class no longer declares', async () => {
    // Dropping it would make the dialog disagree with what the write actually does.
    await archivedAndCleared([entry('1', { retired_field: 42 })])

    const fields = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields

    expect(fields.map(f => f.key)).toEqual(['retired_field'])
    expect(fields[0].label).toBe('retired_field')
  })

  it('orders fields the way the class orders them, unknown keys last', async () => {
    await db.fieldDefinitions.bulkPut([
      fieldDef('pressure', 'فشار', 1),
      fieldDef('temp_out', 'دما', 0)
    ])
    await archivedAndCleared([entry('1', { stray: 1, pressure: 2, temp_out: 3 })])

    const fields = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields

    expect(fields.map(f => f.key)).toEqual(['temp_out', 'pressure', 'stray'])
  })

  it('lists only the fields a restore would change', async () => {
    // A field both versions already agree on is not a decision, and listing it would bury the
    // ones that are.
    await archivedAndCleared(
      [entry('1', { temp: 42, note: 'همان' })],
      [entry('1', { note: 'همان' })]
    )

    const fields = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields

    expect(fields.map(f => f.key)).toEqual(['temp'])
  })

  it('shows the live value a restore would replace', async () => {
    await archivedAndCleared([entry('1', { temp: 42 })], [entry('1', { temp: 99 })])

    const field = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields[0]

    expect(field.mine).toBe(42)
    expect(field.current).toBe(99)
  })

  it('omits a field whose archived value is blank', async () => {
    // The archive's own blank is not a reading, so nothing about it is being restored and there
    // is nothing to ask the operator about.
    await archivedAndCleared(
      [entry('1', { temp: 42, note: '' })],
      [entry('1', { note: 'مقدار' })]
    )

    const fields = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields

    expect(fields.map(f => f.key)).toEqual(['temp'])
  })

  it('reports a media field as media, counted against the device and not the archive', async () => {
    // The archive names two files; one is gone and a third was captured on this tablet after the
    // handover. What the dialog promises has to be what the write produces.
    await db.attachments.bulkPut([
      attachment('a', '1', 'photo'),
      attachment('c', '1', 'photo', { createdAt: NOW + 1 })
    ])
    await archivedAndCleared([entry('1', { photo: buildAttachmentRef(['a', 'b']) })])

    const field = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields[0]

    expect(field.media).toBe(true)
    expect(attachmentIdsOf(field.mine)).toEqual(['a', 'c'])
    expect(field.current).toBeUndefined()
  })

  it('drops a media field with nothing left on the device', async () => {
    // Nothing survives, so nothing is written, and offering zero files would be an empty promise.
    await archivedAndCleared([entry('1', { temp: 42, photo: buildAttachmentRef(['gone']) })])

    const fields = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0].fields

    expect(fields.map(f => f.key)).toEqual(['temp'])
  })

  it('promises exactly what the write then produces', async () => {
    // The end-to-end guard on the whole diff: whatever the operator was shown per field is what
    // the live sheet holds afterwards.
    await db.fieldDefinitions.bulkPut([fieldDef('temp', 'دما', 0)])
    await db.attachments.bulkPut([attachment('a', '1', 'photo')])
    await archivedAndCleared([entry('1', { temp: 42, photo: buildAttachmentRef(['a', 'missing']) })])

    const asset = (await buildRestorePlan(SERVER_ID, OP1))!.assets[0]
    await restoreArchivedEntries(SERVER_ID, OP1, ['1'], LATER)

    const written = readings(await getLogSheetByServerId(SERVER_ID), '1')
    for (const field of asset.fields) {
      expect(written[field.key]).toEqual(field.mine)
    }
    expect(Object.keys(written).sort()).toEqual(asset.fields.map(f => f.key).sort())
  })
})
