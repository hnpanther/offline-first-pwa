import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { saveLogSheet, updateLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { pushPendingLogSheetProgress } from '@/services/sync/progressSync'
import { sheetFormDelivery } from '@/utils/sheetFormDelivery'
import type { LogSheet } from '@/types'

const pushLogSheetProgressBatch = vi.fn()
vi.mock('@/services/api', () => ({
  pushLogSheetProgressBatch: (...args: unknown[]) => pushLogSheetProgressBatch(...args)
}))

/**
 * Every save of the round's own questions reaches the server — not only the first.
 *
 * Reported from the field: online, the first «ذخیره پرسش‌ها» showed up on the panel, the second
 * and third did not, and they arrived only with the final submit. Three things are pinned here,
 * each of which on its own produces that symptom:
 *
 * 1. **Each save is its own report.** Save → accepted push → save again must push again.
 * 2. **A bundle older than what this device delivered does not put older answers back.** A
 *    bundle fetched just before a push lands and merged just after it — the push having cleared
 *    the marker — used to overwrite the delivered answers with the server's previous ones.
 * 3. **A save that lands while a merge is running survives it.** The merge decided from a copy
 *    of the row read before its awaits, then wrote that decision back over the save.
 */

const NOW = 1_700_000_000_000
const SESSION_USER_ID = '7'
let duringMerge: (() => Promise<void>) | null = null

vi.mock('@/services/auth/sessionContext', () => ({
  getSessionUserId: async () => {
    // The window the field defect lived in: the merge has read the row and is still awaiting.
    if (duringMerge) {
      const hook = duringMerge
      duringMerge = null
      await hook()
    }
    return SESSION_USER_ID
  },
  ensureSessionUserId: async () => SESSION_USER_ID
}))

async function seedSheet(overrides: Partial<LogSheet> = {}): Promise<LogSheet> {
  return saveLogSheet({
    localId: 'sheet-local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'گشت ایمنی',
    scopeSummary: '',
    operatorName: 'اپراتور ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'draft',
    syncStatus: 'pending',
    dueAt: NOW + 3_600_000,
    entries: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as LogSheet)
}

/** A bundle as the server sends it; `updatedAt` is `sheet_form_updated_at` on the server. */
function bundle(sheetFormData: Record<string, unknown> | null, updatedAt: number | null) {
  return {
    sheet: {
      id: 55,
      templateName: 'گشت ایمنی',
      status: 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: NOW + 3_600_000,
      sheetFieldDefinitionsSnapshot: [
        { id: 1, key: 'general_status', label: 'وضعیت', dataType: 'text', required: false, order: 1 }
      ],
      sheetFormData,
      sheetFormUpdatedAt: updatedAt
    },
    entries: [],
    context: { fieldDefinitions: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** What the fill page's «ذخیره پرسش‌ها» writes. */
async function saveAnswers(answer: string, at: number) {
  await updateLogSheet('sheet-local-1', {
    sheetFormData: { general_status: answer },
    sheetFormLocallyEditedAt: at,
    progressSyncStatus: 'pending'
  })
}

async function stored(): Promise<LogSheet> {
  return (await db.logSheets.toArray())[0]
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  duringMerge = null
  pushLogSheetProgressBatch.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

function serverAccepts(savedAt: number) {
  pushLogSheetProgressBatch.mockResolvedValueOnce([
    { localId: 'sheet-local-1', serverId: 55, outcome: 'SAVED', savedAt }
  ])
}

describe('every save of the round questions is reported', () => {
  it('pushes the second and the third save, each with its own answers', async () => {
    await seedSheet()
    for (const [i, answer] of ['خوب', 'متوسط', 'بد'].entries()) {
      await saveAnswers(answer, NOW + i)
      serverAccepts(NOW + 1_000 * (i + 1))
      await pushPendingLogSheetProgress()
      const [items] = pushLogSheetProgressBatch.mock.calls[i]
      expect(items[0].sheetFormData).toEqual({ general_status: answer })
      expect((await stored()).sheetFormLocallyEditedAt).toBeUndefined()
    }
    expect(pushLogSheetProgressBatch).toHaveBeenCalledTimes(3)
    expect((await stored()).sheetFormDeliveredAt).toBe(NOW + 3_000)
  })
})

describe('a bundle older than what this device delivered', () => {
  it('does not put the server’s previous answers back', async () => {
    await seedSheet()
    await saveAnswers('متوسط', NOW)
    serverAccepts(NOW + 5_000)
    await pushPendingLogSheetProgress()

    // Fetched before that push landed: the server still held the first answer.
    await applyLogSheetBundle(bundle({ general_status: 'خوب' }, NOW + 1_000))

    const row = await stored()
    expect(row.sheetFormData).toEqual({ general_status: 'متوسط' })
    expect(sheetFormDelivery(row)).toBe('delivered')
  })

  it('still takes a newer correction made in the panel', async () => {
    await seedSheet()
    await saveAnswers('متوسط', NOW)
    serverAccepts(NOW + 5_000)
    await pushPendingLogSheetProgress()

    await applyLogSheetBundle(bundle({ general_status: 'اصلاح سرپرست' }, NOW + 9_000))

    expect((await stored()).sheetFormData).toEqual({ general_status: 'اصلاح سرپرست' })
  })

  it('takes the server’s answers on a device that never delivered any', async () => {
    await seedSheet({ sheetFormData: { general_status: 'قدیمی' } })
    await applyLogSheetBundle(bundle({ general_status: 'از سرور' }, NOW - 50_000))
    expect((await stored()).sheetFormData).toEqual({ general_status: 'از سرور' })
  })
})

describe('a save that lands while a merge is running', () => {
  it('survives the merge and is still queued for the server', async () => {
    await seedSheet({ sheetFormData: { general_status: 'خوب' } })
    // The merge reads the row (no marker, so the server would win), then awaits; the operator
    // saves in that moment.
    duringMerge = () => saveAnswers('متوسط', NOW + 10)

    await applyLogSheetBundle(bundle({ general_status: 'خوب' }, NOW - 1_000))

    const row = await stored()
    expect(row.sheetFormData).toEqual({ general_status: 'متوسط' })
    expect(row.sheetFormLocallyEditedAt).toBe(NOW + 10)
    expect(sheetFormDelivery(row)).toBe('queued')

    serverAccepts(NOW + 20_000)
    await pushPendingLogSheetProgress()
    const [items] = pushLogSheetProgressBatch.mock.calls[0]
    expect(items[0].sheetFormData).toEqual({ general_status: 'متوسط' })
  })
})

describe('what the card says', () => {
  it('names the queue, a refusal and a delivery apart', () => {
    expect(sheetFormDelivery({})).toBeUndefined()
    expect(sheetFormDelivery({ sheetFormLocallyEditedAt: NOW, progressSyncStatus: 'pending' })).toBe('queued')
    expect(sheetFormDelivery({ sheetFormLocallyEditedAt: NOW, progressSyncStatus: 'failed' })).toBe('refused')
    expect(sheetFormDelivery({ sheetFormDeliveredAt: NOW })).toBe('delivered')
  })
})
