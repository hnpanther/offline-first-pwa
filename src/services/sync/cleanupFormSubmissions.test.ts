import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '@/services/storage/db'
import { saveSettings } from '@/services/storage'
import { saveAttachment } from '@/services/storage/attachments'
import {
  cleanupLocalFormSubmissions,
  isEligibleForFormLocalPurge
} from '@/services/sync/cleanupFormSubmissions'
import { LEGACY_RETENTION_WINDOWS } from '@/services/sync/deviceRetention'
import type { DeviceRetentionPolicy, LocalAttachment, LocalFormSubmission } from '@/types'

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

let counter = 0

function form(overrides: Partial<LocalFormSubmission>): LocalFormSubmission {
  counter++
  const localId = overrides.localId ?? `form-local-${counter}`
  return {
    id: localId,
    localId,
    formDefinitionId: '1',
    reporterUnitId: '10',
    subjectUnitId: '11',
    status: 'submitted',
    syncStatus: 'synced',
    serverStatus: 'SUBMITTED',
    formData: { note: 'ok' },
    fieldDefinitionsSnapshot: [],
    createdByUserId: '7',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    submittedAt: NOW - 2 * DAY,
    syncedAt: NOW - 2 * DAY,
    ...overrides
  }
}

async function put(row: LocalFormSubmission): Promise<void> {
  await db.formSubmissions.put(row)
}

beforeEach(async () => {
  settingsFailure.on = false
  if (!db.isOpen()) await db.open()
  await db.formSubmissions.clear()
  await db.attachments.clear()
  await db.settings.clear()
  await saveSettings({ ...DEFAULT_SETTINGS })
})

describe('isEligibleForFormLocalPurge', () => {
  it('never purges an open draft', () => {
    expect(
      isEligibleForFormLocalPurge(
        form({ status: 'draft', syncStatus: 'pending', syncedAt: undefined }),
        NOW,
        LEGACY_RETENTION_WINDOWS
      )
    ).toBe(false)
  })

  it('never purges a pending final', () => {
    expect(
      isEligibleForFormLocalPurge(
        form({ syncStatus: 'pending', syncedAt: undefined }),
        NOW,
        LEGACY_RETENTION_WINDOWS
      )
    ).toBe(false)
  })

  it('purges a synced SUBMITTED after the synced window', () => {
    expect(
      isEligibleForFormLocalPurge(
        form({ syncedAt: NOW - 25 * HOUR }),
        NOW,
        LEGACY_RETENTION_WINDOWS
      )
    ).toBe(true)
    expect(
      isEligibleForFormLocalPurge(
        form({ syncedAt: NOW - 23 * HOUR }),
        NOW,
        LEGACY_RETENTION_WINDOWS
      )
    ).toBe(false)
  })

  it('treats APPROVED like SUBMITTED for retention', () => {
    expect(
      isEligibleForFormLocalPurge(
        form({ serverStatus: 'APPROVED', syncedAt: NOW - 25 * HOUR }),
        NOW,
        LEGACY_RETENTION_WINDOWS
      )
    ).toBe(true)
  })

  it('keeps failed forms even with legacy or enabled unsynced retention', () => {
    const failed = form({
      syncStatus: 'failed',
      syncedAt: undefined,
      submittedAt: NOW - 8 * DAY
    })
    expect(isEligibleForFormLocalPurge(failed, NOW, LEGACY_RETENTION_WINDOWS)).toBe(false)
    expect(
      isEligibleForFormLocalPurge(failed, NOW, {
        syncedMs: 24 * HOUR,
        failedMs: null,
        expiredDraftMs: null
      })
    ).toBe(false)
  })
})

describe('cleanupLocalFormSubmissions', () => {
  it('deletes an aged synced form and its synced attachments; keeps drafts', async () => {
    const keep = form({
      localId: 'draft-keep',
      status: 'draft',
      syncStatus: 'pending',
      syncedAt: undefined
    })
    const drop = form({
      localId: 'synced-drop',
      syncedAt: NOW - 25 * HOUR,
      submittedAt: NOW - 26 * HOUR
    })
    await put(keep)
    await put(drop)
    await saveAttachment({
      id: 'att-1',
      formSubmissionLocalId: drop.localId,
      formSubmissionId: '99',
      fieldKey: 'sig',
      kind: 'IMAGE',
      mimeType: 'image/png',
      sizeBytes: 10,
      syncStatus: 'synced',
      createdAt: NOW - 26 * HOUR
    } as LocalAttachment)

    expect(await cleanupLocalFormSubmissions(NOW)).toBe(1)
    expect(await db.formSubmissions.get(keep.id)).toBeTruthy()
    expect(await db.formSubmissions.get(drop.id)).toBeUndefined()
    expect(await db.attachments.get('att-1')).toBeUndefined()
  })

  it('honours deviceRetention synced window from settings', async () => {
    const policy: DeviceRetentionPolicy = {
      syncedRetentionHours: 48,
      unsyncedPurgeEnabled: false,
      unsyncedRetentionHours: 168
    }
    await saveSettings({ ...DEFAULT_SETTINGS, deviceRetention: policy })
    await put(form({ localId: 'young', syncedAt: NOW - 30 * HOUR }))
    expect(await cleanupLocalFormSubmissions(NOW)).toBe(0)
    await put(form({ localId: 'old', syncedAt: NOW - 49 * HOUR }))
    expect(await cleanupLocalFormSubmissions(NOW)).toBe(1)
  })

  it('purges nothing when settings cannot be read', async () => {
    await put(form({ localId: 'kept', syncedAt: NOW - 100 * DAY }))
    settingsFailure.on = true
    expect(await cleanupLocalFormSubmissions(NOW)).toBe(0)
    expect(await db.formSubmissions.get('kept')).toBeTruthy()
  })
})
