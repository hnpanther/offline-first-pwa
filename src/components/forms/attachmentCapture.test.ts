import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptureGuard, fieldReferenceFor } from '@/components/forms/AttachmentFieldInput'
import { db } from '@/services/storage/db'
import {
  attachmentIdsOf,
  buildAttachmentRef,
  getAttachmentsByIds,
  getAttachmentsForEntry,
  removeAttachment,
  saveAttachment
} from '@/services/storage/attachments'
import type { LocalAttachment } from '@/types'

vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteRemoteAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * Recording a clip, deleting it, and recording again.
 *
 * <h2>The reported failure</h2>
 *
 * <p>An operator records one audio or video clip on a one-clip field, changes their mind, deletes
 * it — and can never record again: the counter reads 1 / 1 and the button stays disabled. Nothing
 * on screen can be deleted to free the slot.
 *
 * <h2>What was actually happening</h2>
 *
 * <p>Two defects, and only together do they produce a dead end.
 *
 * <ol>
 *   <li><b>One recording was saved twice.</b> Every ending resolves the recorder's
 *       {@code finished} promise and the component routes all of them through one stop handler.
 *       A manual stop resolves {@code finished} from inside that handler, so the effect watching
 *       it re-entered in the same tick — before {@code setRecorder(null)} had run the cleanup
 *       that would have cancelled it, and past a guard that read the stale non-null recorder from
 *       its closure. The already-finished recorder returned the same blob, and a second identical
 *       row was written.</li>
 *   <li><b>The published reference was built from a stale id list.</b> Both saves read the same
 *       {@code ids}, so the second overwrote the first: one row ended up named by nothing. The
 *       list of items is built from the reference, the ceiling is counted from the device — so
 *       the orphan was invisible and countable at the same time.</li>
 * </ol>
 *
 * <p>Reproduced in a browser against a real draft sheet: one tap on «پایان ضبط» produced two
 * 5757-byte rows and a counter of 2 / 1; deleting the one visible item left 1 / 1 with the record
 * button disabled. Video behaved identically — one recording, two rows.
 */

const SHEET = 'local-1'
const ASSET = '7'
const FIELD = 'Audio'
/** Whoever is holding the tablet in these cases. Media is owned per row, not per sheet. */
const ME = '9'

function clip(id: string, overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id,
    logSheetLocalId: SHEET,
    logSheetServerId: '55',
    assetId: ASSET,
    fieldKey: FIELD,
    kind: 'AUDIO',
    mimeType: 'audio/webm',
    sizeBytes: 5757,
    durationMs: 2016,
    blob: new Blob(['x'], { type: 'audio/webm' }),
    syncStatus: 'pending',
    createdAt: Date.now(),
    createdByUserId: ME,
    ...overrides
  } as LocalAttachment
}

/** What the component now publishes after a capture, and what it counts. */
async function publishedReference(currentIds: string[]): Promise<string[]> {
  const onDevice = await getAttachmentsForEntry(SHEET, ASSET, FIELD, ME)
  return fieldReferenceFor(onDevice, currentIds).ids
}

async function counterFor(value: unknown): Promise<number> {
  const ids = attachmentIdsOf(value)
  const rows = await getAttachmentsByIds(ids)
  const forField = await getAttachmentsForEntry(SHEET, ASSET, FIELD, ME)
  const counted = new Set(rows.map(r => r.id))
  forField.forEach(r => counted.add(r.id))
  return counted.size
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.attachments.clear()
  await db.logSheets.clear()
})

// ─────────────────────────────────────────────────────────────────────────────
// One recording, one row
// ─────────────────────────────────────────────────────────────────────────────

describe('the capture guard', () => {
  it('lets the first stop through and refuses a second in the same tick', () => {
    const guard = createCaptureGuard()

    expect(guard.begin()).toBe(true)
    expect(guard.begin()).toBe(false)
  })

  it('re-arms once the save has finished, so the next recording is not blocked', () => {
    const guard = createCaptureGuard()

    guard.begin()
    guard.end()

    expect(guard.begin()).toBe(true)
  })

  it('re-arms even when the save threw', () => {
    // `end()` runs in a finally, so a failed capture must not leave the control dead.
    const guard = createCaptureGuard()
    guard.begin()
    try {
      throw new Error('capture failed')
    } catch {
      guard.end()
    }

    expect(guard.begin()).toBe(true)
  })

  it('admits exactly one of many simultaneous stops', () => {
    // The manual stop and the `finished` watcher both arrive; only one may save.
    const guard = createCaptureGuard()

    const admitted = [0, 1, 2, 3].filter(() => guard.begin())

    expect(admitted).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reference always says what the device holds
// ─────────────────────────────────────────────────────────────────────────────

describe('the published field reference', () => {
  it('names every row this device holds for the field', async () => {
    await saveAttachment(clip('a'))
    await saveAttachment(clip('b', { createdAt: Date.now() + 1 }))

    expect(await publishedReference([])).toEqual(['a', 'b'])
  })

  it('does not lose the first capture when a second lands in the same tick', async () => {
    // The stale-closure bug: both saves read `ids` as [] and the second overwrote the first.
    await saveAttachment(clip('first'))
    const afterFirst = await publishedReference([])

    await saveAttachment(clip('second', { createdAt: Date.now() + 1 }))
    const afterSecond = await publishedReference([]) // deliberately the same stale list

    expect(afterFirst).toEqual(['first'])
    // Both rows must be named, whichever id list the caller happened to be holding.
    expect(afterSecond).toEqual(['first', 'second'])
  })

  it('adopts a row the form value never named', async () => {
    // The orphan. Counted against the ceiling, absent from the list, impossible to delete.
    await saveAttachment(clip('named'))
    await saveAttachment(clip('orphan', { createdAt: Date.now() + 1 }))

    const repaired = fieldReferenceFor(
      await getAttachmentsForEntry(SHEET, ASSET, FIELD, ME),
      ['named']
    )

    expect(repaired.changed).toBe(true)
    expect(repaired.ids).toEqual(['named', 'orphan'])
  })

  it('reports no change when the reference already matches, so opening a field is inert', async () => {
    await saveAttachment(clip('a'))
    await saveAttachment(clip('b', { createdAt: Date.now() + 1 }))

    expect(fieldReferenceFor(await getAttachmentsForEntry(SHEET, ASSET, FIELD, ME), ['a', 'b']).changed)
      .toBe(false)
  })

  it('drops an id whose row is gone rather than keeping a dangling reference', async () => {
    await saveAttachment(clip('a'))

    const repaired = fieldReferenceFor(
      await getAttachmentsForEntry(SHEET, ASSET, FIELD, ME),
      ['a', 'vanished']
    )

    expect(repaired.ids).toEqual(['a'])
    expect(repaired.changed).toBe(true)
  })

  it('never names a row queued for deletion', async () => {
    await saveAttachment(clip('a'))
    await removeAttachment('a')

    expect(await publishedReference(['a'])).toEqual([])
  })

  it('survives two deletes in quick succession without resurrecting one', async () => {
    // `handleRemove` used to subtract from the id list its render closed over, so two deletes
    // disagreed and the loser's list named a row that was already gone — a reference that
    // resolves to nothing, which is what the counter and the ceiling then argue about.
    await saveAttachment(clip('a'))
    await saveAttachment(clip('b', { createdAt: Date.now() + 1 }))
    const stale = ['a', 'b']

    await removeAttachment('a')
    const afterFirst = await publishedReference(stale)
    await removeAttachment('b')
    const afterSecond = await publishedReference(stale) // the same stale list again

    expect(afterFirst).toEqual(['b'])
    expect(afterSecond).toEqual([])
  })

  it('keeps the reference to this field only', async () => {
    await saveAttachment(clip('mine'))
    await saveAttachment(clip('other-field', { fieldKey: 'Video', kind: 'VIDEO' }))
    await saveAttachment(clip('other-asset', { assetId: '9' }))

    expect(await publishedReference([])).toEqual(['mine'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reported sequence, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('record, delete, record again on a one-clip field', () => {
  const MAX = 1

  it('a single recording leaves the field at 1 of 1, not 2 of 1', async () => {
    const guard = createCaptureGuard()

    // The operator presses stop; the `finished` watcher fires in the same tick.
    if (guard.begin()) await saveAttachment(clip('take-1'))
    if (guard.begin()) await saveAttachment(clip('take-1-duplicate'))
    guard.end()

    const value = buildAttachmentRef(await publishedReference([]))
    expect(await counterFor(value)).toBe(1)
    expect(await counterFor(value)).toBeLessThanOrEqual(MAX)
  })

  it('deleting it frees the slot, so the operator can record again', async () => {
    const guard = createCaptureGuard()
    if (guard.begin()) await saveAttachment(clip('take-1'))
    if (guard.begin()) await saveAttachment(clip('take-1-duplicate'))
    guard.end()
    let value = buildAttachmentRef(await publishedReference([]))

    for (const id of attachmentIdsOf(value)) await removeAttachment(id)
    value = buildAttachmentRef(await publishedReference(attachmentIdsOf(value)))

    expect(await counterFor(value)).toBe(0)
    expect(await counterFor(value) >= MAX).toBe(false)
  })

  it('and the re-recording is stored and named', async () => {
    const guard = createCaptureGuard()
    if (guard.begin()) await saveAttachment(clip('take-1'))
    guard.end()
    let value = buildAttachmentRef(await publishedReference([]))
    for (const id of attachmentIdsOf(value)) await removeAttachment(id)

    guard.end()
    if (guard.begin()) await saveAttachment(clip('take-2', { createdAt: Date.now() + 10 }))
    value = buildAttachmentRef(await publishedReference([]))

    expect(attachmentIdsOf(value)).toEqual(['take-2'])
    expect(await counterFor(value)).toBe(1)
  })

  it('frees a tablet that is already carrying an orphan', async () => {
    // The recovery path for devices stuck by the old build: the field is opened, the orphan is
    // adopted into the reference, and the operator finally has something to delete.
    await saveAttachment(clip('visible'))
    await saveAttachment(clip('orphan', { createdAt: Date.now() + 1 }))
    const stuck = buildAttachmentRef(['visible'])
    expect(await counterFor(stuck)).toBe(2)

    const repaired = buildAttachmentRef(await publishedReference(attachmentIdsOf(stuck)))
    for (const id of attachmentIdsOf(repaired)) await removeAttachment(id)
    const afterDelete = buildAttachmentRef(await publishedReference(attachmentIdsOf(repaired)))

    expect(await counterFor(afterDelete)).toBe(0)
  })
})

/**
 * A tablet that changed hands mid-round.
 *
 * <p>The local sheet row is **reused** when a supervisor reassigns: same `localId`, readings
 * emptied by `reset-draft`, and `db.attachments` untouched. So the previous operator's rows are
 * still keyed to this exact (sheet, asset, field) — and every read here used to find them.
 *
 * <p>What that produced in the field: the new operator opened the fill form and the previous
 * operator's photographs were **adopted** into their own reading, displayed as theirs, and
 * submitted under their name; the counter said the field was full so they could not capture
 * their own; and deleting one queued a server-side delete of somebody else's evidence.
 */
describe('media captured by a colleague on the same device', () => {
  const THEM = '4'

  it('is not adopted into this operator\'s reading', async () => {
    await saveAttachment(clip('theirs', { createdByUserId: THEM }))

    // The reading is empty — `reset-draft` cleared it when the sheet changed hands.
    expect(await publishedReference([])).toEqual([])
  })

  it('does not fill this operator\'s field counter', async () => {
    await saveAttachment(clip('theirs-1', { createdByUserId: THEM }))
    await saveAttachment(clip('theirs-2', { createdByUserId: THEM }))

    expect(await counterFor(buildAttachmentRef([]))).toBe(0)
  })

  it('leaves this operator free to capture their own, which is all they then hold', async () => {
    await saveAttachment(clip('theirs', { createdByUserId: THEM }))
    await saveAttachment(clip('mine'))

    expect(await publishedReference([])).toEqual(['mine'])
    expect(await counterFor(buildAttachmentRef(['mine']))).toBe(1)
  })

  /**
   * The reason adoption exists at all — a duplicated capture leaving a row nothing references —
   * still works. Narrowing it to the owner must not disarm it.
   */
  it('still adopts this operator\'s own orphan', async () => {
    await saveAttachment(clip('mine-orphan'))

    expect(await publishedReference([])).toEqual(['mine-orphan'])
  })

  /**
   * Rows captured before `createdByUserId` existed. Refusing them would strand media that cannot
   * be re-recorded, so they fall back to the current user — the same rule
   * `isNfcFaultReportOutboundOwnedByUser` already uses. The Dexie v3 backfill is what keeps this
   * fallback applying to almost nothing.
   */
  it('treats a row with no owner as this operator\'s', async () => {
    await saveAttachment(clip('legacy', { createdByUserId: undefined }))

    expect(await publishedReference([])).toEqual(['legacy'])
  })
})
