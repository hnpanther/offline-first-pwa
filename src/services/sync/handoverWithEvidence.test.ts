import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, saveSettings } from '@/services/storage'
import { saveAttachment } from '@/services/storage/attachments'
import { syncManager } from '@/services/sync'
import { cleanupLocalLogSheets } from '@/services/sync/cleanupLogSheets'
import { isUndeliveredRound } from '@/services/sync/undelivered'
import { DEFAULT_SETTINGS } from '@/services/storage/db'
import { ApiError } from '@/services/api/client'
import type { LocalAttachment, LogSheet } from '@/types'

const submitLogSheetsBatch = vi.fn()
const uploadAttachment = vi.fn()
vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: (...a: unknown[]) => submitLogSheetsBatch(...a),
  uploadAttachment: (...a: unknown[]) => uploadAttachment(...a),
  pushLogSheetProgressBatch: vi.fn().mockResolvedValue([]),
  reportSyncBacklog: vi.fn().mockResolvedValue(undefined),
  submitNfcFaultReportsBatch: vi.fn(),
  deleteAttachment: vi.fn()
}))

/**
 * A round taken from one operator and given to another, on one shared tablet, with a photograph —
 * end to end through the real `SyncManager` and attachment queue, on a real (fake) IndexedDB.
 *
 * Operator A walks the round offline, photographs a pump, completes it and signs out, still
 * offline. The supervisor hands the round to operator B, who signs in on the same tablet. Then A
 * signs back in. At no point may anything of A's be sent under B's session, and at the end
 * everything of A's must be on the server — the readings kept for review, the photograph as the
 * void's evidence — or, where the server refuses it, still on the tablet, counted and never purged.
 */

const A = '4'
const B = '9'
const NOW = 1_800_000_000_000
const PHOTO = '33333333-3333-4333-8333-333333333333'

function completedByA(): LogSheet {
  return {
    id: 'local-1',
    localId: 'local-1',
    serverId: '55',
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    // The inbox merge leaves an unsent completion alone, assignee included (reassignRoundTrip).
    assigneeUserId: A,
    localOwnerUserId: A,
    status: 'submitted',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-a',
    completedAt: NOW - 600_000,
    submittedAt: NOW - 600_000,
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 88, pump_photo: { type: 'attachment', ids: [PHOTO] } },
        locallyEditedAt: NOW - 700_000,
        createdAt: NOW - 900_000,
        updatedAt: NOW - 700_000
      }
    ],
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 600_000
  } as LogSheet
}

function photoByA(): LocalAttachment {
  return {
    id: PHOTO,
    createdByUserId: A,
    logSheetLocalId: 'local-1',
    logSheetServerId: '55',
    assetId: '7',
    fieldKey: 'pump_photo',
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    sizeBytes: 3,
    blob: new Blob(['jpg'], { type: 'image/jpeg' }),
    syncStatus: 'pending',
    createdAt: NOW - 700_000
  } as LocalAttachment
}

async function signIn(userId: string): Promise<void> {
  await db.syncMeta.put({ key: 'sessionUserId', value: Number(userId) })
  await db.syncMeta.put({
    key: 'authSession',
    value: {
      accessToken: `token-${userId}`,
      tokenType: 'Bearer',
      expiresAt: NOW + 86_400_000,
      username: `op-${userId}`,
      fullName: 'اپراتور',
      roles: ['OPERATOR'],
      permissions: ['POST:/api/log-sheets/batch']
    }
  })
}

async function aRound(): Promise<LogSheet> {
  const found = await getLogSheet('local-1')
  if (!found) throw new Error('operator A’s round disappeared — that is data loss')
  return found
}

const answer = (fields: Record<string, unknown>) =>
  submitLogSheetsBatch.mockImplementation(async (items: Array<{ localId: string; serverId: number }>) =>
    items.map(item => ({ localId: item.localId, serverId: item.serverId, ...fields }))
  )

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
  await db.settings.clear()
  submitLogSheetsBatch.mockReset()
  uploadAttachment.mockReset()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.stubGlobal('navigator', { onLine: true })
  await saveLogSheet(completedByA())
  await saveAttachment(photoByA())
})

describe('a round handed from A to B on one tablet, with a photograph', () => {
  it('sends nothing of A’s while B is signed in', async () => {
    await signIn(B)
    answer({ outcome: 'SUBMITTED' })
    uploadAttachment.mockResolvedValue({})

    await syncManager.sync()

    expect(submitLogSheetsBatch).not.toHaveBeenCalled()
    expect(uploadAttachment).not.toHaveBeenCalled()
    expect((await aRound()).syncStatus).toBe('pending')
    expect((await db.attachments.get(PHOTO))?.syncStatus).toBe('pending')
  })

  it('delivers all of it once A is back: readings kept for review, photograph as evidence', async () => {
    await signIn(B)
    await syncManager.sync()
    await signIn(A)
    answer({ outcome: 'SUPERSEDED', error: 'این کار به اپراتور دیگری واگذار شده است.', kept: true })
    uploadAttachment.mockResolvedValue({})

    await syncManager.sync()

    expect(submitLogSheetsBatch).toHaveBeenCalledOnce()
    const sent = submitLogSheetsBatch.mock.calls[0][0][0]
    expect(sent.entries[0].formData).toEqual({ temp: 88, pump_photo: { type: 'attachment', ids: [PHOTO] } })
    const round = await aRound()
    expect(round).toMatchObject({ syncStatus: 'failed', lastSubmitOutcome: 'SUPERSEDED', serverKeptAt: NOW })
    expect(isUndeliveredRound(round, NOW)).toBe(false)

    expect(uploadAttachment).toHaveBeenCalledOnce()
    expect(uploadAttachment.mock.calls[0][0]).toMatchObject({ id: PHOTO, logSheetServerId: '55' })
    expect((await db.attachments.get(PHOTO))?.syncStatus).toBe('synced')
  })

  it('keeps everything on the tablet when the server declines to keep it, and never purges it', async () => {
    await signIn(A)
    answer({ outcome: 'SUPERSEDED', error: 'این کار به اپراتور دیگری واگذار شده است.', kept: false })
    // The server names no void for this file, so it refuses the evidence — a final answer.
    uploadAttachment.mockRejectedValue(new ApiError(403, 'دسترسی ندارید'))
    await saveSettings({
      ...DEFAULT_SETTINGS,
      deviceRetention: { syncedRetentionHours: 1, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 }
    })

    await syncManager.sync()
    // Ten years of purges later, with the most aggressive policy the panel allows.
    await cleanupLocalLogSheets(NOW + 10 * 365 * 86_400_000)

    const round = await aRound()
    expect(round.entries[0].formData.temp).toBe(88)
    expect(isUndeliveredRound(round, NOW)).toBe(true)
    const photo = await db.attachments.get(PHOTO)
    expect(photo?.blob).toBeDefined()
    expect(photo).toMatchObject({ syncStatus: 'failed', permanentFailure: true, failedStatus: 403 })
  })

  it('purges the round only after the window, once the server holds it — and keeps the queued photo', async () => {
    await signIn(A)
    answer({ outcome: 'SUPERSEDED', kept: true })
    uploadAttachment.mockRejectedValue(new ApiError(0, 'ارتباط با سرور برقرار نشد.'))
    await saveSettings({
      ...DEFAULT_SETTINGS,
      deviceRetention: { syncedRetentionHours: 24, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 }
    })

    await syncManager.sync()
    expect(await cleanupLocalLogSheets(NOW + 71 * 3_600_000)).toBe(0)
    expect(await cleanupLocalLogSheets(NOW + 73 * 3_600_000)).toBe(1)

    // The photograph has not reached the server yet, so it outlives its round on the device and
    // the queue still delivers it (it carries its own server sheet id).
    expect((await db.attachments.get(PHOTO))?.syncStatus).toBe('pending')
  })
})
