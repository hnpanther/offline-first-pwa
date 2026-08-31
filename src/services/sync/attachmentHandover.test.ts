import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/services/storage/db'
import { getLogSheetByServerId, saveLogSheet } from '@/services/storage'
import { applyLogSheetBundle } from '@/services/sync/logSheetSync'
import { activateUserSession } from '@/services/auth/sessionContext'
import { archivedLogSheetViewId } from '@/services/storage/logSheetArchive'
import {
  getAttachmentsForEntry,
  isAttachmentOwnedByUser,
  saveAttachment
} from '@/services/storage/attachments'
import { isAttachmentUploadableByUser } from '@/utils/attachmentOwnership'
import { applyOperatorEntrySave } from '@/utils/entryTimestamps'
import type { LogSheetBundleDto } from '@/services/api'
import type { LocalAttachment, LogSheet, LogSheetEntryData } from '@/types'

vi.mock('@/services/api', () => ({
  submitLogSheetsBatch: vi.fn(),
  submitNfcFaultReportsBatch: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchBootstrap: vi.fn()
}))

/**
 * A shared tablet whose round changed hands, and the media on it.
 *
 * <h2>The reported failure</h2>
 *
 * Operator A takes a round, goes offline, photographs the equipment and hits final submit — all
 * without a link. Still offline, they sign out. A supervisor reassigns the round to operator B,
 * who signs in on the **same tablet**. B opens the fill page and sees A's photographs as if they
 * had taken them. And when the round goes back to A, A's own media appears to be gone.
 *
 * <h2>Why it happened</h2>
 *
 * There is one local row per server sheet and it is **reused** across operators: reassignment
 * takes the `reset-draft` path, which empties the readings but leaves `localId` alone and never
 * touches `db.attachments`. Every read keyed on `logSheetLocalId`, so A's rows were still
 * "this field's attachments" for B — counted against B's field ceiling, and *adopted* into B's
 * own reading the moment the field was opened (`AttachmentFieldInput`'s orphan repair, which had
 * no notion of whose orphan it was).
 *
 * The root cause was that `LocalAttachment` had no owner. `logSheets` has `localOwnerUserId` and
 * `nfcFaultReports` has `createdByUserId`; attachments were the third outbound-syncable table
 * and the one that never got it — exactly what AGENTS.md warns is not automatic.
 *
 * <h2>What these pin</h2>
 *
 * The whole sequence against a real Dexie database, not the predicate in isolation: the failure
 * was only ever visible as *sign out → reassign → sign in → open the field*, and a rule that
 * returns the right answer can still be read from the wrong place.
 */

const SERVER_ID = '55'
const LOCAL_ID = 'local-1'
const ASSET = '7'
const FIELD = 'Pic'
const OPERATOR_A = '4'
const OPERATOR_B = '9'
const NOW = 1_700_000_000_000

function entry(formData: Record<string, unknown>): LogSheetEntryData {
  return {
    assetId: ASSET,
    assetName: 'پمپ ۱',
    subFunctionCode: 'SF-1',
    subFunctionTag: 'TAG-1',
    classId: '2',
    formData,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000
  }
}

function sheetOwnedByA(overrides: Partial<LogSheet> = {}): LogSheet {
  return {
    id: LOCAL_ID,
    localId: LOCAL_ID,
    serverId: SERVER_ID,
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: OPERATOR_A,
    localOwnerUserId: OPERATOR_A,
    status: 'submitted',
    syncStatus: 'pending',
    serverStatus: 'IN_PROGRESS',
    dueAt: NOW + 3_600_000,
    clientActionId: 'action-1',
    entries: [applyOperatorEntrySave(entry({}), { Pic: { type: 'attachment', ids: ['a-photo'] } }, 'manual', NOW)],
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    ...overrides
  } as LogSheet
}

function photo(id: string, owner: string | undefined, overrides: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    id,
    logSheetLocalId: LOCAL_ID,
    logSheetServerId: SERVER_ID,
    assetId: ASSET,
    fieldKey: FIELD,
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    sizeBytes: 1234,
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    syncStatus: 'pending',
    createdAt: NOW,
    ...(owner ? { createdByUserId: owner } : {}),
    ...overrides
  } as LocalAttachment
}

/** The sheet as the server hands it to B: same sheet, new assignee, still open. */
function bundleAssignedTo(userId: string): LogSheetBundleDto {
  return {
    sheet: {
      id: Number(SERVER_ID),
      templateId: 3,
      templateName: 'راند روزانه',
      scopeSummary: 'سالن ۱',
      status: 'IN_PROGRESS',
      assigneeUserId: Number(userId),
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
        filledByName: null,
        createdAt: NOW - 10_000,
        updatedAt: NOW - 5_000
      }
    ],
    context: null
  } as LogSheetBundleDto
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.attachments.clear()
  await db.syncMeta.clear()
  await db.logSheetUserArchives.clear()
})

/** A signs in, works offline, submits, signs out; the supervisor gives the round to B. */
async function handOverToB(): Promise<void> {
  await activateUserSession('op-a', OPERATOR_A)
  await saveLogSheet(sheetOwnedByA())
  await saveAttachment(photo('a-photo', OPERATOR_A))

  // B signs in on the same tablet, then the inbox brings the reassigned sheet.
  await activateUserSession('op-b', OPERATOR_B)
  await applyLogSheetBundle(bundleAssignedTo(OPERATOR_B))
}

describe('a round handed from one operator to another on the same tablet', () => {
  it('leaves the new operator with an empty field, not a colleague\'s photographs', async () => {
    await handOverToB()

    const forField = await getAttachmentsForEntry(LOCAL_ID, ASSET, FIELD, OPERATOR_B)

    expect(forField).toEqual([])
  })

  /**
   * The row is still on the device — nothing here deletes another operator's evidence. It is
   * simply not B's to see, count, adopt, upload or delete.
   */
  it('keeps the previous operator\'s row on the device, owned by them', async () => {
    await handOverToB()

    const stored = await db.attachments.get('a-photo')
    expect(stored).toBeDefined()
    expect(stored?.createdByUserId).toBe(OPERATOR_A)
    expect(isAttachmentOwnedByUser(stored!, OPERATOR_B)).toBe(false)
    expect(isAttachmentOwnedByUser(stored!, OPERATOR_A)).toBe(true)
  })

  it('does not let the new operator send or delete it', async () => {
    await handOverToB()

    const sheet = await getLogSheetByServerId(SERVER_ID)
    const row = await db.attachments.get('a-photo')

    expect(isAttachmentUploadableByUser(sheet!, OPERATOR_B, row!)).toBe(false)
  })

  it('shows the new operator only what they capture themselves', async () => {
    await handOverToB()
    await saveAttachment(photo('b-photo', OPERATOR_B))

    const forField = await getAttachmentsForEntry(LOCAL_ID, ASSET, FIELD, OPERATOR_B)

    expect(forField.map(r => r.id)).toEqual(['b-photo'])
  })

  /**
   * The other half of the report: the first operator's own media must stay reachable **to them**.
   *
   * Their work is archived under a synthetic `archive:<serverId>:<userId>` route id, which is
   * not a stored `logSheetLocalId` — so looking it up as one found nothing and their
   * photographs appeared to have vanished. It resolves through the snapshot's own key instead.
   */
  it('still shows the previous operator their own media on the archived card', async () => {
    await handOverToB()

    const viewId = archivedLogSheetViewId(SERVER_ID, OPERATOR_A)
    const forField = await getAttachmentsForEntry(viewId, ASSET, FIELD, OPERATOR_A)

    expect(forField.map(r => r.id)).toEqual(['a-photo'])
  })

  /**
   * And an archived card is read as the operator it belongs to. B cannot reach A's archive in
   * the UI — the list only offers each user their own — but the lookup must not depend on that.
   */
  it('does not leak one operator\'s archive to whoever is holding the tablet', async () => {
    await handOverToB()
    await saveAttachment(photo('b-photo', OPERATOR_B))

    const viewId = archivedLogSheetViewId(SERVER_ID, OPERATOR_A)
    const forField = await getAttachmentsForEntry(viewId, ASSET, FIELD, OPERATOR_B)

    expect(forField.map(r => r.id)).toEqual(['a-photo'])
  })
})

describe('media captured before the owner field existed', () => {
  /**
   * Refusing an unstamped row would strand evidence of work that cannot be repeated, so it falls
   * back to the current user — the rule `isNfcFaultReportOutboundOwnedByUser` already uses. The
   * Dexie v3 backfill exists so this applies to almost nothing.
   */
  it('is treated as belonging to whoever is signed in', async () => {
    await activateUserSession('op-b', OPERATOR_B)
    await saveLogSheet(sheetOwnedByA({ localOwnerUserId: OPERATOR_B, assigneeUserId: OPERATOR_B }))
    await saveAttachment(photo('legacy', undefined))

    const forField = await getAttachmentsForEntry(LOCAL_ID, ASSET, FIELD, OPERATOR_B)

    expect(forField.map(r => r.id)).toEqual(['legacy'])
  })
})

describe('an unbound session', () => {
  /**
   * No id means no provable owner. Showing media on that basis is what the whole mechanism
   * exists to prevent, so it shows none — the binding heals on the next `ensureSessionUserId`.
   */
  it('is shown no media at all rather than everything', async () => {
    await activateUserSession('op-a', OPERATOR_A)
    await saveLogSheet(sheetOwnedByA())
    await saveAttachment(photo('a-photo', OPERATOR_A))

    expect(await getAttachmentsForEntry(LOCAL_ID, ASSET, FIELD, null)).toEqual([])
  })
})
