import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import {
  archiveLogSheetForUser,
  getArchivedLogSheetsForUser
} from '@/services/storage/logSheetArchive'
import {
  ROUND_RESTORE_ID,
  buildRestorePlan,
  restoreArchivedEntries
} from '@/services/storage/restoreArchivedWork'
import { attachmentIdsOf, buildAttachmentRef } from '@/services/storage/attachments'
import { loadLogSheetsForSessionUser } from '@/services/auth/sessionContext'
import {
  archiveHoldsRoundAnswersTheLiveRowLacks,
  sheetHasLocalWork
} from '@/utils/logSheetLocalData'
import {
  alignLocalWorkflowWithServer,
  shouldArchiveBeforeServerOverwrite
} from '@/utils/logSheetWorkflow'
import type { LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'
import type { ServerLogSheet } from '@/services/api'

vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * A round's own answers on the archive path — what happens to them when a round is taken away
 * from the operator who answered them.
 *
 * <h2>The defect</h2>
 *
 * Every "is there work here?" decision on that path asked only about the **assets**. A round
 * answered only at round level — every asset-less round, and any round where the operator began
 * with its questions — therefore counted as empty: reassigning it away cleared the live row
 * **without archiving it**, the server's answers overwrote the operator's, and whatever had not
 * synced was gone. The archived ("revoked") copy, when one existed, could be read but never
 * restored, and its card could be hidden while it still held answers nobody else had.
 */

const OP1 = '7'
const SERVER_ID = '91'
const NOW = 1_700_000_000_000

const QUESTIONS: FieldDefinition[] = [
  { id: 'q1', key: 'all_checked', label: 'آیا همه لوله‌ها بازدید شد؟', dataType: 'select', required: false, order: 1, updatedAt: NOW } as FieldDefinition,
  { id: 'q2', key: 'note', label: 'توضیح', dataType: 'text', required: false, order: 2, updatedAt: NOW } as FieldDefinition,
  { id: 'q3', key: 'area_photo', label: 'عکس محوطه', dataType: 'image', required: false, order: 3, updatedAt: NOW } as FieldDefinition
]

function round(overrides: Partial<LogSheet> = {}, entries: LogSheetEntryData[] = []): LogSheet {
  return {
    id: 'local-r',
    localId: 'local-r',
    serverId: SERVER_ID,
    templateId: '4',
    templateName: 'بازدید محوطه',
    assigneeUserId: OP1,
    localOwnerUserId: OP1,
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    entries,
    sheetFieldDefinitions: QUESTIONS,
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function roundPhoto(id: string, createdAt = NOW): LocalAttachment {
  // Round-level media: no assetId, which is the one bit that says "this belongs to the round".
  return {
    id,
    logSheetLocalId: 'local-r',
    logSheetServerId: SERVER_ID,
    fieldKey: 'area_photo',
    kind: 'IMAGE',
    mimeType: 'image/webp',
    sizeBytes: 100,
    blob: new Blob(['x'], { type: 'image/webp' }),
    syncStatus: 'pending',
    createdAt
  } as LocalAttachment
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.logSheetUserArchives.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
})

// =============================================================================================

describe('what counts as work', () => {
  it('a round answered only at round level is work', () => {
    expect(sheetHasLocalWork(round({ sheetFormData: { note: 'لوله ۳ نشتی دارد' } }))).toBe(true)
    expect(sheetHasLocalWork(round({ sheetFormData: {} }))).toBe(false)
    // A blank answer is not an answer.
    expect(sheetHasLocalWork(round({ sheetFormData: { note: '   ' } }))).toBe(false)
  })

  it('an archive holding a round answer the live row lacks is not hidden by the live row', () => {
    expect(
      archiveHoldsRoundAnswersTheLiveRowLacks(
        { sheetFormData: { note: 'x', all_checked: 'بله' } },
        { sheetFormData: { all_checked: 'بله' } }
      )
    ).toBe(true)
    expect(
      archiveHoldsRoundAnswersTheLiveRowLacks(
        { sheetFormData: { all_checked: 'بله' } },
        { sheetFormData: { all_checked: 'خیر' } }
      )
    ).toBe(false)
  })
})

describe('the workflow decisions', () => {
  const server = (assigneeUserId: number): ServerLogSheet =>
    ({ id: 91, templateId: 4, templateName: 'x', scopeSummary: '', status: 'ASSIGNED', assigneeUserId }) as ServerLogSheet

  it('a reassigned draft answered only at round level is reset, so it is archived first', () => {
    const local = round({ sheetFormData: { note: 'x' }, assigneeUserId: '7', localOwnerUserId: '7' })

    expect(alignLocalWorkflowWithServer(local, server(8))).toBe('reset-draft')
  })

  it('an empty reassigned draft is still left alone', () => {
    expect(alignLocalWorkflowWithServer(round({ sheetFormData: {} }), server(8))).toBeNull()
  })

  it('round answers are archived before somebody else’s completion overwrites them', () => {
    expect(shouldArchiveBeforeServerOverwrite(round({ sheetFormData: { note: 'x' } }), false)).toBe(true)
    expect(shouldArchiveBeforeServerOverwrite(round({ sheetFormData: {} }), false)).toBe(false)
  })
})

// =============================================================================================

describe('archiving', () => {
  it('archives a round that holds only round answers — it used to be skipped', async () => {
    await archiveLogSheetForUser(round({ sheetFormData: { note: 'لوله ۳ نشتی دارد' } }), OP1)

    const [archived] = await getArchivedLogSheetsForUser(OP1)
    expect(archived).toBeDefined()
    // The archived ("revoked") view renders from this copy, so both halves must travel with it.
    expect(archived.sheetFormData).toEqual({ note: 'لوله ۳ نشتی دارد' })
    expect(archived.sheetFieldDefinitions?.map(q => q.key)).toEqual(['all_checked', 'note', 'area_photo'])
  })

  it('keeps the archive visible while it holds answers the cleared live row does not', async () => {
    await archiveLogSheetForUser(round({ sheetFormData: { note: 'x' } }), OP1)
    // The round came back to the same operator, cleared.
    const live = round({ sheetFormData: {} })
    await saveLogSheet(live)

    const shown = await loadLogSheetsForSessionUser([live], OP1, new Set([SERVER_ID]))

    expect(shown.some(s => s.localId.startsWith('archive:'))).toBe(true)
  })
})

// =============================================================================================

describe('restoring round answers', () => {
  it('offers the round as one unit, first, labelled the way the fill page labels it', async () => {
    await archiveLogSheetForUser(round({ sheetFormData: { all_checked: 'بله', note: 'لوله ۳' } }), OP1)
    await saveLogSheet(round({ sheetFormData: {} }))

    const plan = await buildRestorePlan(SERVER_ID, OP1)

    expect(plan?.assets[0].assetId).toBe(ROUND_RESTORE_ID)
    expect(plan?.assets[0].assetName).toBe('پرسش‌های این کار')
    expect(plan?.assets[0].conflict).toBe(false)
    expect(plan?.assets[0].fields.map(f => f.label)).toEqual(['آیا همه لوله‌ها بازدید شد؟', 'توضیح'])
  })

  it('writes the answers back and queues them for sync exactly as the card’s own save does', async () => {
    await archiveLogSheetForUser(round({ sheetFormData: { note: 'لوله ۳' } }), OP1)
    await saveLogSheet(round({ sheetFormData: {} }))

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, [ROUND_RESTORE_ID], NOW + 1)

    const live = await getLogSheetByServerId(SERVER_ID)
    expect(outcome.restoredAssetIds).toEqual([ROUND_RESTORE_ID])
    expect(live?.sheetFormData).toEqual({ note: 'لوله ۳' })
    // The merge marker and the queued report — without these the next bundle merge would let the
    // server's empty answers win, and nothing would tell the supervisor.
    expect(live?.sheetFormLocallyEditedAt).toBe(NOW + 1)
    expect(live?.progressSyncStatus).toBe('pending')
    expect(outcome.archiveCleared).toBe(true)
  })

  it('rebuilds a round photo reference from the files actually on the device', async () => {
    await db.attachments.bulkPut([roundPhoto('ph-1', NOW), roundPhoto('ph-2', NOW + 1)])
    // The archive names one file that is gone and misses one captured later.
    await archiveLogSheetForUser(
      round({ sheetFormData: { area_photo: buildAttachmentRef(['ph-1', 'gone']) } }),
      OP1
    )
    await saveLogSheet(round({ sheetFormData: {} }))

    const plan = await buildRestorePlan(SERVER_ID, OP1)
    expect(plan?.assets[0].missingAttachmentIds).toEqual(['gone'])

    await restoreArchivedEntries(SERVER_ID, OP1, [ROUND_RESTORE_ID], NOW + 2)
    const live = await getLogSheetByServerId(SERVER_ID)
    expect(attachmentIdsOf(live?.sheetFormData?.area_photo)).toEqual(['ph-1', 'ph-2'])
  })

  it('does not offer answers the live round already holds', async () => {
    await archiveLogSheetForUser(round({ sheetFormData: { note: 'x' } }), OP1)
    await saveLogSheet(round({ sheetFormData: { note: 'x' } }))

    expect(await buildRestorePlan(SERVER_ID, OP1)).toBeNull()
  })

  it('restoring only the assets keeps the round answers reachable', async () => {
    const asset: LogSheetEntryData = {
      assetId: '1', assetName: 'پمپ ۱', subFunctionCode: 'SF-1', subFunctionTag: 'T-1',
      classId: '2', formData: { temp: 40 }, createdAt: NOW, updatedAt: NOW
    }
    await archiveLogSheetForUser(round({ sheetFormData: { note: 'x' } }, [asset]), OP1)
    await saveLogSheet(round({ sheetFormData: {} }, [{ ...asset, formData: {} }]))

    const outcome = await restoreArchivedEntries(SERVER_ID, OP1, ['1'], NOW + 3)

    expect(outcome.archiveCleared).toBe(false)
    const plan = await buildRestorePlan(SERVER_ID, OP1)
    expect(plan?.assets.map(a => a.assetId)).toEqual([ROUND_RESTORE_ID])
  })
})
