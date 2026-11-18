import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '@/services/storage/db'
import { getLogSheet, saveLogSheet, saveSettings } from '@/services/storage'
import { saveAttachment } from '@/services/storage/attachments'
import { cleanupLocalLogSheets, isEligibleForLocalPurge } from '@/services/sync/cleanupLogSheets'
import { LEGACY_RETENTION_WINDOWS } from '@/services/sync/deviceRetention'
import { SYNC_OUTCOME_MESSAGES } from '@/utils/logSheetStatus'
import type { DeviceRetentionPolicy, LocalAttachment, LogSheet } from '@/types'

/**
 * Backend roadmap §41 — the local purge, run against a real (fake) IndexedDB.
 *
 * Sync is the part of this app that must not break, so these cases cover every kind of local round
 * under every kind of policy, at the edges of each window, and the rows that must survive whatever
 * the policy says. The issue they close is P-01: a round that never reached the server was deleted
 * from the only device holding its readings.
 */

// Lets one case make the settings row unreadable without touching any other storage call.
const settingsFailure = vi.hoisted(() => ({ on: false }))
vi.mock('@/services/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/storage')>()
  return {
    ...actual,
    getSettings: async () => {
      if (settingsFailure.on) throw new Error('settings row unreadable')
      return actual.getSettings()
    }
  }
})

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000
const USER = '7'

let counter = 0

function sheet(overrides: Partial<LogSheet>): LogSheet {
  counter++
  const localId = overrides.localId ?? `local-${counter}`
  return {
    localId,
    serverId: String(1000 + counter),
    templateId: '3',
    templateName: 'راند روزانه',
    scopeSummary: 'سالن ۱',
    assigneeUserId: USER,
    localOwnerUserId: USER,
    status: 'submitted',
    syncStatus: 'synced',
    serverStatus: 'SUBMITTED',
    entries: [
      {
        assetId: '7',
        assetName: 'پمپ ۱',
        subFunctionCode: 'SF-1',
        subFunctionTag: 'TAG-1',
        classId: '2',
        formData: { temp: 42 },
        createdAt: NOW - 30 * DAY,
        updatedAt: NOW - 30 * DAY
      }
    ],
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    ...overrides,
    id: localId
  } as LogSheet
}

/** Accepted by the server `ageMs` ago. */
const synced = (ageMs: number, extra: Partial<LogSheet> = {}) =>
  sheet({ status: 'submitted', syncStatus: 'synced', submittedAt: NOW - ageMs - 60_000, syncedAt: NOW - ageMs, ...extra })

/**
 * Refused by the server and **kept** for review (`kept: true`, backend V25); submitted `ageMs` ago.
 * The only kind of refused round any window may purge (issue P-05) — see {@link onlyHere}.
 */
const failed = (ageMs: number, extra: Partial<LogSheet> = {}) =>
  sheet({
    status: 'submitted',
    syncStatus: 'failed',
    serverStatus: 'EXPIRED',
    syncError: SYNC_OUTCOME_MESSAGES.EXPIRED,
    lastSubmitOutcome: 'EXPIRED',
    serverKeptAt: NOW - ageMs,
    submittedAt: NOW - ageMs,
    ...extra
  })

/** Refused, and the server holds none of it: the readings exist only on this tablet. */
const onlyHere = (ageMs: number, extra: Partial<LogSheet> = {}) =>
  failed(ageMs, { serverKeptAt: undefined, ...extra })

/** A local edit marker on the round's one asset — readings the operator actually entered. */
const edited = (at: number): Partial<LogSheet> => ({
  entries: [
    {
      assetId: '7',
      assetName: 'پمپ ۱',
      subFunctionCode: 'SF-1',
      subFunctionTag: 'TAG-1',
      classId: '2',
      formData: { temp: 42 },
      createdAt: at,
      updatedAt: at,
      locallyEditedAt: at
    }
  ]
})

/** A draft whose deadline passed `ageMs` ago, never delivered. */
const expiredDraft = (ageMs: number, extra: Partial<LogSheet> = {}) =>
  sheet({
    status: 'draft',
    syncStatus: 'pending',
    serverStatus: 'EXPIRED',
    dueAt: NOW - ageMs,
    submittedAt: undefined,
    ...extra
  })

async function withPolicy(policy: DeviceRetentionPolicy | undefined) {
  await saveSettings({ ...DEFAULT_SETTINGS, ...(policy ? { deviceRetention: policy } : {}) })
}

async function exists(s: LogSheet) {
  return (await getLogSheet(s.localId)) !== undefined
}

const DEFAULT_POLICY: DeviceRetentionPolicy = {
  syncedRetentionHours: 24,
  unsyncedPurgeEnabled: false,
  unsyncedRetentionHours: 168
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.logSheets.clear()
  await db.settings.clear()
  await db.attachments.clear()
  settingsFailure.on = false
})

// ---------------------------------------------------------------------------------------------
// 1. A device that never received a policy behaves exactly as before
// ---------------------------------------------------------------------------------------------

describe('no policy received yet — the shipped constants, unchanged', () => {
  it('purges a synced round after 24 h and not before', async () => {
    await withPolicy(undefined)
    const old = synced(DAY + HOUR)
    const young = synced(DAY - HOUR)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('purges a refused round after 7 days and not before', async () => {
    await withPolicy(undefined)
    const old = failed(7 * DAY + HOUR)
    const young = failed(7 * DAY - HOUR)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('purges an expired draft 24 h after its deadline and not before', async () => {
    await withPolicy(undefined)
    const old = expiredDraft(DAY + HOUR)
    const young = expiredDraft(DAY - HOUR)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('treats an expired draft recognised only by its sync error the same way', async () => {
    await withPolicy(undefined)
    const old = expiredDraft(DAY + HOUR, { serverStatus: 'IN_PROGRESS', syncError: SYNC_OUTCOME_MESSAGES.EXPIRED })
    await saveLogSheet(old)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
  })

  it('is what an empty settings table means, too', async () => {
    // A fresh install before its first bootstrap: no settings row at all.
    const old = failed(8 * DAY)
    await saveLogSheet(old)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// 2. The default policy: undelivered rounds are never purged
// ---------------------------------------------------------------------------------------------

describe('the default policy — the purge of undelivered rounds is off', () => {
  it('keeps a refused round however old it is', async () => {
    await withPolicy(DEFAULT_POLICY)
    const ancient = failed(5 * 365 * DAY)
    await saveLogSheet(ancient)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await exists(ancient)).toBe(true)
  })

  it('keeps an expired draft however long ago its deadline passed — issue P-01', async () => {
    await withPolicy(DEFAULT_POLICY)
    const ancient = expiredDraft(5 * 365 * DAY)
    await saveLogSheet(ancient)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await exists(ancient)).toBe(true)
    // …with its readings, which are the point.
    expect((await getLogSheet(ancient.localId))?.entries[0].formData).toEqual({ temp: 42 })
  })

  it('still purges a synced round after 24 h', async () => {
    await withPolicy(DEFAULT_POLICY)
    const old = synced(DAY + HOUR)
    const young = synced(DAY - HOUR)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('keeps the unsynced hours irrelevant while the switch is off', async () => {
    await withPolicy({ ...DEFAULT_POLICY, unsyncedRetentionHours: 72 })
    const r = failed(100 * DAY)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Configured windows
// ---------------------------------------------------------------------------------------------

describe('a configured synced window', () => {
  it('purges after the configured hours and not before', async () => {
    await withPolicy({ ...DEFAULT_POLICY, syncedRetentionHours: 6 })
    const old = synced(6 * HOUR + 60_000)
    const young = synced(6 * HOUR - 60_000)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('keeps a synced round for the whole of a long window', async () => {
    await withPolicy({ ...DEFAULT_POLICY, syncedRetentionHours: 720 })
    const r = synced(29 * DAY)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await cleanupLocalLogSheets(NOW + 2 * DAY)).toBe(1)
  })

  it('does not purge at exactly the boundary — strictly older than the window', async () => {
    await withPolicy({ ...DEFAULT_POLICY, syncedRetentionHours: 6 })
    const r = synced(6 * HOUR)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })

  it('anchors on syncedAt, falling back to submittedAt when there is none', async () => {
    await withPolicy({ ...DEFAULT_POLICY, syncedRetentionHours: 6 })
    const r = synced(0, { syncedAt: undefined, submittedAt: NOW - 7 * HOUR })
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
  })
})

describe('the purge of undelivered rounds switched on', () => {
  const ON: DeviceRetentionPolicy = { syncedRetentionHours: 24, unsyncedPurgeEnabled: true, unsyncedRetentionHours: 72 }

  it('purges a refused round after the configured hours and not before', async () => {
    await withPolicy(ON)
    const old = failed(72 * HOUR + 60_000)
    const young = failed(72 * HOUR - 60_000)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('purges an expired draft the configured hours after its deadline and not before', async () => {
    await withPolicy(ON)
    const old = expiredDraft(72 * HOUR + 60_000)
    const young = expiredDraft(72 * HOUR - 60_000)
    await saveLogSheet(old)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(young)).toBe(true)
  })

  it('gives an expired draft longer than the old 24 h, since the floor is 72 h', async () => {
    await withPolicy(ON)
    const r = expiredDraft(2 * DAY)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })

  it('clamps a stored window below the floor rather than purging early', async () => {
    await withPolicy({ ...ON, unsyncedRetentionHours: 1 })
    const r = failed(10 * HOUR)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// 4. What no setting changes
// ---------------------------------------------------------------------------------------------

describe('rounds that are never purged, whatever the settings say', () => {
  // The most aggressive policy there is, ten years on.
  const AGGRESSIVE: DeviceRetentionPolicy = {
    syncedRetentionHours: 1,
    unsyncedPurgeEnabled: true,
    unsyncedRetentionHours: 72
  }
  const LATER = NOW + 10 * 365 * DAY

  it('never purges an active draft', async () => {
    await withPolicy(AGGRESSIVE)
    const r = sheet({ status: 'draft', syncStatus: 'pending', serverStatus: 'IN_PROGRESS', dueAt: undefined })
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(await exists(r)).toBe(true)
  })

  it('never purges a submitted round still waiting to sync', async () => {
    await withPolicy(AGGRESSIVE)
    const pending = sheet({ status: 'submitted', syncStatus: 'pending', submittedAt: NOW })
    const syncing = sheet({ status: 'submitted', syncStatus: 'syncing', submittedAt: NOW })
    await saveLogSheet(pending)
    await saveLogSheet(syncing)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(await exists(pending)).toBe(true)
    expect(await exists(syncing)).toBe(true)
  })

  it('never purges a reopened round while its new deadline stands', async () => {
    await withPolicy(AGGRESSIVE)
    const r = synced(30 * DAY, { serverStatus: 'IN_PROGRESS', dueAt: LATER + HOUR })
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(await exists(r)).toBe(true)
  })

  it('purges a reopened round under the ordinary rule once its new deadline has passed', async () => {
    await withPolicy(AGGRESSIVE)
    const r = synced(30 * DAY, { serverStatus: 'IN_PROGRESS', dueAt: NOW - HOUR })
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
  })

  it('keeps an attachment still waiting to upload when its round is purged', async () => {
    await withPolicy(AGGRESSIVE)
    const r = failed(100 * DAY)
    await saveLogSheet(r)
    const base: Omit<LocalAttachment, 'id' | 'syncStatus'> = {
      createdByUserId: USER,
      logSheetLocalId: r.localId,
      logSheetServerId: r.serverId,
      assetId: '7',
      fieldKey: 'photo',
      kind: 'IMAGE',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      createdAt: NOW - 100 * DAY
    } as Omit<LocalAttachment, 'id' | 'syncStatus'>
    await saveAttachment({ ...base, id: 'waiting', syncStatus: 'pending' } as LocalAttachment)
    await saveAttachment({ ...base, id: 'retrying', syncStatus: 'failed' } as LocalAttachment)
    await saveAttachment({ ...base, id: 'uploaded', syncStatus: 'synced' } as LocalAttachment)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)

    expect(await db.attachments.get('waiting')).toBeDefined()
    expect(await db.attachments.get('retrying')).toBeDefined()
    expect(await db.attachments.get('uploaded')).toBeUndefined()
  })

  // Issue P-05: the switch purges what the server already holds a copy of — never the only copy.

  it('never purges a refusal whose readings only this tablet holds', async () => {
    await withPolicy(AGGRESSIVE)
    const expired = onlyHere(400 * DAY)
    const invalid = onlyHere(400 * DAY, { lastSubmitOutcome: 'VALIDATION_ERROR', serverStatus: 'IN_PROGRESS' })
    const gone = onlyHere(400 * DAY, { lastSubmitOutcome: 'ERROR', serverStatus: 'IN_PROGRESS' })
    for (const r of [expired, invalid, gone]) await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    for (const r of [expired, invalid, gone]) expect(await exists(r)).toBe(true)
  })

  it('never purges a refusal the server said it declined to keep, whatever the outcome says', async () => {
    // V26's cap: SUPERSEDED usually means kept, and `kept: false` is the one exception.
    await withPolicy(AGGRESSIVE)
    const declined = onlyHere(400 * DAY, {
      lastSubmitOutcome: 'SUPERSEDED',
      serverStatus: 'SUBMITTED',
      serverKeepRefusedAt: NOW - 400 * DAY
    })
    await saveLogSheet(declined)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(await exists(declined)).toBe(true)
  })

  it('purges a SUPERSEDED refusal an older server answered, which it has always kept', async () => {
    await withPolicy(AGGRESSIVE)
    const voided = onlyHere(400 * DAY, { lastSubmitOutcome: 'SUPERSEDED', serverStatus: 'SUBMITTED' })
    await saveLogSheet(voided)

    expect(await cleanupLocalLogSheets(LATER)).toBe(1)
  })

  it('never purges an expired draft holding readings the server has not kept', async () => {
    await withPolicy(AGGRESSIVE)
    const draft = expiredDraft(400 * DAY, edited(NOW - 400 * DAY))
    await saveLogSheet(draft)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(await exists(draft)).toBe(true)
  })

  it('purges an expired draft once the server kept its late readings', async () => {
    await withPolicy(AGGRESSIVE)
    const at = NOW - 400 * DAY
    const draft = expiredDraft(400 * DAY, { ...edited(at), lateProgressSentMarker: at, lateProgressKeptMarker: at })
    await saveLogSheet(draft)

    expect(await cleanupLocalLogSheets(LATER)).toBe(1)
  })

  it('never purges an unheld refusal on the shipped constants either', async () => {
    await withPolicy(undefined)
    const r = onlyHere(400 * DAY)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(LATER)).toBe(0)
    expect(isEligibleForLocalPurge(r, LATER, { ...LEGACY_RETENTION_WINDOWS })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// 5. Unreadable values never mean «purge now»
// ---------------------------------------------------------------------------------------------

describe('a value nobody can read', () => {
  it('purges nothing at all when the settings row cannot be read', async () => {
    const r1 = failed(100 * DAY)
    const r2 = synced(100 * DAY)
    const r3 = expiredDraft(100 * DAY)
    await saveLogSheet(r1)
    await saveLogSheet(r2)
    await saveLogSheet(r3)
    settingsFailure.on = true

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    expect(await exists(r1)).toBe(true)
    expect(await exists(r2)).toBe(true)
    expect(await exists(r3)).toBe(true)
  })

  it('keeps undelivered rounds when the stored policy is corrupted', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      deviceRetention: { syncedRetentionHours: 0, unsyncedPurgeEnabled: 'yes', unsyncedRetentionHours: -3 } as unknown as DeviceRetentionPolicy
    })
    const r1 = failed(100 * DAY)
    const r2 = expiredDraft(100 * DAY)
    const young = synced(DAY - HOUR)
    await saveLogSheet(r1)
    await saveLogSheet(r2)
    await saveLogSheet(young)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
    // Zero hours fell back to 24, not to "purge now".
    expect(await exists(young)).toBe(true)
  })

  it('keeps undelivered rounds when the stored policy is not even an object', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      deviceRetention: 'garbage' as unknown as DeviceRetentionPolicy
    })
    const r = failed(100 * DAY)
    await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// 6. The pure decision, mixed — the same answer for a table full of every kind of round
// ---------------------------------------------------------------------------------------------

describe('isEligibleForLocalPurge', () => {
  it('purges exactly the delivered rounds past their window from a mixed table', async () => {
    await withPolicy(DEFAULT_POLICY)
    const rows = {
      oldSynced: synced(2 * DAY),
      youngSynced: synced(HOUR),
      oldFailed: failed(400 * DAY),
      oldExpired: expiredDraft(400 * DAY),
      draft: sheet({ status: 'draft', syncStatus: 'pending', serverStatus: 'IN_PROGRESS' }),
      pending: sheet({ status: 'submitted', syncStatus: 'pending', submittedAt: NOW - 400 * DAY }),
      reopened: synced(400 * DAY, { serverStatus: 'ASSIGNED', dueAt: NOW + DAY })
    }
    for (const r of Object.values(rows)) await saveLogSheet(r)

    expect(await cleanupLocalLogSheets(NOW)).toBe(1)
    const survivors = await db.logSheets.toArray()
    expect(survivors.map(s => s.localId).sort()).toEqual(
      Object.entries(rows)
        .filter(([name]) => name !== 'oldSynced')
        .map(([, r]) => r.localId)
        .sort()
    )
  })

  it('answers the legacy question exactly as the code before §41 did', () => {
    // A direct check of the pure function against the constants, independent of storage.
    expect(isEligibleForLocalPurge(failed(7 * DAY + 1), NOW, { ...LEGACY_RETENTION_WINDOWS })).toBe(true)
    expect(isEligibleForLocalPurge(failed(7 * DAY), NOW, { ...LEGACY_RETENTION_WINDOWS })).toBe(false)
    expect(isEligibleForLocalPurge(expiredDraft(DAY + 1), NOW, { ...LEGACY_RETENTION_WINDOWS })).toBe(true)
    expect(isEligibleForLocalPurge(synced(DAY + 1), NOW, { ...LEGACY_RETENTION_WINDOWS })).toBe(true)
  })
})
