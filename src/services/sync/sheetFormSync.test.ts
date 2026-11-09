import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, updateLogSheet } from '@/services/storage'
import { applyLogSheetBundle, toBatchPayload } from '@/services/sync/logSheetSync'
import {
  getLogSheetsPendingProgress,
  hasDirtySheetForm,
  pushPendingLogSheetProgress
} from '@/services/sync/progressSync'
import type { LogSheet, LogSheetEntryData } from '@/types'

const pushLogSheetProgressBatch = vi.fn()
vi.mock('@/services/api', () => ({
  pushLogSheetProgressBatch: (...args: unknown[]) => pushLogSheetProgressBatch(...args)
}))

/**
 * The round's **own** questions on the device — «آیا همه لوله‌ها بازدید شد؟», asked once per
 * sheet rather than once per asset.
 *
 * Three properties, and each of them is a rule this app learned somewhere else first:
 *
 * 1. **The device's opinion is recorded by the save, never inferred from the data.** After any
 *    sync the local answers *are* the server's answers, so no predicate over `sheetFormData`
 *    can tell "this device answered" from "this device was sent". `mapServerEntryToLocal`
 *    documents the two predicates that were tried at entry level and the readings each lost;
 *    `sheetFormLocallyEditedAt` is the same answer one level up.
 * 2. **A round can be walked with no asset touched at all.** The operator answers the
 *    round-level questions first, so anything that decides "is there something to report" by
 *    counting entries would strand that answer on the device.
 * 3. **An absent key means "not carried", never "clear it".** An older build sends no
 *    `sheetFormData`, and its submissions must leave what the web panel stored exactly where
 *    it is.
 */

const NOW = 1_700_000_000_000
const SESSION_USER_ID = '7'

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '10',
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '3',
    formData: { temp: 42 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

async function seedSheet(overrides: Partial<LogSheet> = {}): Promise<LogSheet> {
  return saveLogSheet({
    localId: 'sheet-local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: '',
    operatorName: 'اپراتور ۱',
    assigneeUserId: SESSION_USER_ID,
    localOwnerUserId: SESSION_USER_ID,
    status: 'draft',
    syncStatus: 'pending',
    dueAt: NOW + 3_600_000,
    entries: [entry()],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as LogSheet)
}

/** A bundle as the server sends it — the questions and answers ride on the sheet entity. */
function bundle(sheetFormData: Record<string, unknown> | null, questions = true) {
  return {
    sheet: {
      id: 55,
      templateId: 3,
      templateName: 'راند روزانه',
      status: 'IN_PROGRESS',
      assigneeUserId: Number(SESSION_USER_ID),
      dueAt: NOW + 3_600_000,
      ...(questions
        ? {
            sheetFieldDefinitionsSnapshot: [
              { id: 1, key: 'pipes_checked', label: 'لوله‌ها', dataType: 'text', required: false, order: 1 }
            ]
          }
        : {}),
      sheetFormData
    },
    entries: [{ assetId: 10, classId: 3, formData: { temp: 42 } }],
    context: { fieldDefinitions: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.syncMeta.clear()
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(SESSION_USER_ID) })
  pushLogSheetProgressBatch.mockReset()
  pushLogSheetProgressBatch.mockResolvedValue([
    { localId: 'sheet-local-1', serverId: 55, outcome: 'SAVED', savedAt: NOW + 1000 }
  ])
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

// ---------------------------------------------------------------- coming down

describe('a bundle brings the questions and the answers', () => {
  it('takes a custom round’s questions from the resolved list while the sheet has no snapshot', async () => {
    // A custom round's snapshot column is null until its first answer — the approver adds the
    // questions after creating it. Reading only that column showed an empty round on pickup.
    const custom = bundle(null, false)
    custom.sheet.templateId = null
    custom.entries = []
    custom.context = {
      fieldDefinitions: [],
      sheetFieldDefinitions: [
        { id: 7, key: 'area_clear', label: 'آیا محوطه پاک بود؟', dataType: 'checkbox', required: false, order: 1 },
        { id: 8, key: 'note', label: 'یادداشت', dataType: 'text', required: false, order: 2 }
      ]
    }

    await applyLogSheetBundle(custom)

    const stored = (await db.logSheets.toArray())[0]
    expect(stored.sheetFieldDefinitions?.map(q => q.key)).toEqual(['area_clear', 'note'])
  })

  it('prefers the resolved list over the column when a server sends both', async () => {
    const both = bundle(null, true)
    both.context = {
      fieldDefinitions: [],
      sheetFieldDefinitions: [
        { id: 9, key: 'resolved_one', label: 'حل‌شده', dataType: 'text', required: false, order: 1 }
      ]
    }

    await applyLogSheetBundle(both)

    const stored = (await db.logSheets.toArray())[0]
    expect(stored.sheetFieldDefinitions?.map(q => q.key)).toEqual(['resolved_one'])
  })

  it('copies both onto the stored sheet, with no contract change', async () => {
    await applyLogSheetBundle(bundle({ pipes_checked: 'از سرور' }))

    const stored = await getLogSheet('55-local') ?? (await db.logSheets.toArray())[0]
    expect(stored.sheetFieldDefinitions).toHaveLength(1)
    expect(stored.sheetFieldDefinitions?.[0].key).toBe('pipes_checked')
    expect(stored.sheetFormData).toEqual({ pipes_checked: 'از سرور' })
  })

  it('keeps the device answers when this device has answered and not yet delivered them', async () => {
    await seedSheet({
      sheetFormData: { pipes_checked: 'از دستگاه' },
      sheetFormLocallyEditedAt: NOW,
      syncStatus: 'pending'
    })

    await applyLogSheetBundle(bundle({ pipes_checked: 'از سرور' }))

    const stored = (await db.logSheets.toArray())[0]
    // The single condition the entries use: a marker the save itself wrote. Asking the data
    // instead would be unable to tell these two strings apart in the direction that matters.
    expect(stored.sheetFormData).toEqual({ pipes_checked: 'از دستگاه' })
    expect(stored.sheetFormLocallyEditedAt).toBe(NOW)
  })

  it('takes the server answers when this device has no opinion, and drops nothing of its own', async () => {
    await seedSheet({ sheetFormData: { pipes_checked: 'قدیمی' } })

    await applyLogSheetBundle(bundle({ pipes_checked: 'تازه از سرور' }))

    const stored = (await db.logSheets.toArray())[0]
    expect(stored.sheetFormData).toEqual({ pipes_checked: 'تازه از سرور' })
    // And the marker goes with the values. Left standing it would hand this device every
    // future merge of these answers — `localEditsPending` exists to stop exactly that.
    expect(stored.sheetFormLocallyEditedAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------- going up

describe('what the device sends', () => {
  it('omits the key entirely when the round asks nothing', async () => {
    const sheet = await seedSheet()
    expect('sheetFormData' in toBatchPayload(sheet)).toBe(false)
  })

  it('carries the answers on a submit when there are any', async () => {
    const sheet = await seedSheet({ sheetFormData: { pipes_checked: 'بله' } })
    expect(toBatchPayload(sheet).sheetFormData).toEqual({ pipes_checked: 'بله' })
  })

  it('reports a round answered with no asset touched', async () => {
    // Two things had to change for this: the predicate that decides a sheet has something to
    // report, and the loop that skips a sheet with no dirty entries. A round where the
    // operator answered the questions first and nothing else is real, reportable work.
    await seedSheet({
      entries: [entry({ locallyEditedAt: undefined })],
      sheetFormData: { pipes_checked: 'بله' },
      sheetFormLocallyEditedAt: NOW
    })

    const pending = await getLogSheetsPendingProgress(SESSION_USER_ID)
    expect(pending).toHaveLength(1)

    await pushPendingLogSheetProgress()

    const [items] = pushLogSheetProgressBatch.mock.calls[0]
    expect(items).toHaveLength(1)
    expect(items[0].entries).toEqual([])
    expect(items[0].sheetFormData).toEqual({ pipes_checked: 'بله' })
  })

  it('sends no round-level answers when this device has no opinion about them', async () => {
    // The answers are on the sheet because the server sent them. Echoing them back on every
    // tick would be this device arguing with the panel about values it never entered.
    await seedSheet({
      entries: [entry({ locallyEditedAt: NOW })],
      sheetFormData: { pipes_checked: 'از پنل' }
    })

    await pushPendingLogSheetProgress()

    const [items] = pushLogSheetProgressBatch.mock.calls[0]
    expect(items[0].sheetFormData).toBeUndefined()
  })
})

// ---------------------------------------------------------------- after the push

describe('after the server accepts a push', () => {
  it('forgets the marker, so the server wins the next merge', async () => {
    await seedSheet({
      entries: [entry({ locallyEditedAt: undefined })],
      sheetFormData: { pipes_checked: 'بله' },
      sheetFormLocallyEditedAt: NOW
    })

    await pushPendingLogSheetProgress()

    const stored = (await db.logSheets.toArray())[0]
    expect(stored.sheetFormLocallyEditedAt).toBeUndefined()
    expect(hasDirtySheetForm(stored)).toBe(false)
  })

  it('keeps a marker the operator stamped again while the request was in flight', async () => {
    await seedSheet({
      entries: [entry({ locallyEditedAt: undefined })],
      sheetFormData: { pipes_checked: 'اول' },
      sheetFormLocallyEditedAt: NOW
    })

    // The operator answers again mid-request. The same rule the entry markers follow: an
    // answer given after the payload was built has not been delivered, and forgetting its
    // marker would lose it silently.
    pushLogSheetProgressBatch.mockImplementation(async () => {
      await updateLogSheet('sheet-local-1', {
        sheetFormData: { pipes_checked: 'دوم' },
        sheetFormLocallyEditedAt: NOW + 5
      })
      return [{ localId: 'sheet-local-1', serverId: 55, outcome: 'SAVED', savedAt: NOW + 1000 }]
    })

    await pushPendingLogSheetProgress()

    const stored = (await db.logSheets.toArray())[0]
    expect(stored.sheetFormData).toEqual({ pipes_checked: 'دوم' })
    expect(stored.sheetFormLocallyEditedAt).toBe(NOW + 5)
  })
})
