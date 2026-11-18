import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/services/api/client'
import { db, DEFAULT_SETTINGS, MAIN_DATABASE_NAME, openDatabase } from '@/services/storage/db'
import { getSettings, saveSettings } from '@/services/storage'
import type { LoginChallengeResponse } from '@/types/device'
import {
  WIPED_NOTICE_KEY,
  WIPE_MARKER_KEY,
  beginDeviceWipe,
  checkForWipeOrder,
  confirmPendingWipe,
  defaultDeviceWipeDeps,
  readWipeMarker,
  resetWipeConfirmationForTests,
  restoreServerUrlAfterWipe,
  resumeDeviceWipe,
  takeWipedNotice,
  wipeOrderOf,
  type DeviceWipeDeps
} from './deviceWipe'
import {
  createIdentity,
  discardIdentity,
  discardRetiredIdentity,
  loadIdentity,
  loadRetiredIdentity,
  saveEnrollmentState,
  wipeMessage
} from './deviceIdentity'

/**
 * Wipe on revoke (backend V28) — the tablet's half.
 *
 * This is the one place the app deletes readings that exist nowhere else, on purpose, so it is
 * tested against a real (fake) IndexedDB holding real rounds, photos and lists, with the order
 * arriving the way the server sends it. What must hold:
 *
 *  - nothing is deleted without an order in a challenge answer, and nothing on a malformed one;
 *  - the deletion runs before the database is opened, survives being interrupted, and never runs
 *    twice for one order;
 *  - everything the app holds goes, except the server address and the key that still owes the
 *    server its signed confirmation;
 *  - the confirmation is signed with that key over exactly the order, retried until the server
 *    answers, and the key let go once it has.
 */

const DEVICE_ID = 42
const ORDERED_AT = 1_763_452_800_123
const FINGERPRINT = 'ab'.repeat(32)

class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

let local: MemoryStorage
let session: MemoryStorage
let reload: ReturnType<typeof vi.fn>
let broadcast: ReturnType<typeof vi.fn>
let confirm: ReturnType<typeof vi.fn>
let fetchChallenge: ReturnType<typeof vi.fn>

function deps(overrides: Partial<DeviceWipeDeps> = {}): DeviceWipeDeps {
  return {
    ...defaultDeviceWipeDeps,
    local: () => local,
    session: () => session,
    reload,
    broadcast,
    confirm,
    fetchChallenge,
    now: () => 1_800_000_000_000,
    ...overrides
  }
}

async function enrolledIdentity(): Promise<void> {
  await createIdentity('tablet 7')
  await saveEnrollmentState({ status: 'approved', requestId: DEVICE_ID, keyFingerprint: FINGERPRINT })
}

/** A tablet with a shift's worth of undelivered work on it. */
async function seedLocalWork(): Promise<void> {
  await openDatabase()
  await saveSettings({ ...DEFAULT_SETTINGS, serverUrl: 'https://logsheet.plant.example' })
  await db.logSheets.put({ id: 'ls-1', localId: 'ls-1', serverId: '10', status: 'submitted', syncStatus: 'failed', entries: [] } as never)
  await db.attachments.put({ id: 'a-1', logSheetLocalId: 'ls-1', syncStatus: 'pending', blob: new Blob(['jpeg']) } as never)
  await db.logSheetUserArchives.put({ id: 'ar-1', serverId: '9', userId: '3', sheet: {} } as never)
  await db.nfcFaultReports.put({ id: 'nf-1', syncStatus: 'pending', createdAt: 1 } as never)
  await db.lookupLists.put({ id: 'staff', code: 'staff' } as never)
  await db.lookupItems.put({ id: 1, listId: 'staff', code: 'P-1', label: 'Ali' } as never)
  await db.syncMeta.put({ key: 'authSession', value: { accessToken: 't' } })
  local.setItem('some.app.key', 'x')
  session.setItem('some.session.key', 'y')
}

beforeEach(async () => {
  local = new MemoryStorage()
  session = new MemoryStorage()
  reload = vi.fn()
  broadcast = vi.fn()
  confirm = vi.fn(async () => ({ deviceId: DEVICE_ID, confirmedAt: 1 }))
  fetchChallenge = vi.fn(async (): Promise<LoginChallengeResponse> => ({ enforced: true, deviceStatus: 'APPROVED', nonce: 'n' }))
  resetWipeConfirmationForTests()
  await discardIdentity()
  await discardRetiredIdentity()
  db.close()
  await Dexie.delete(MAIN_DATABASE_NAME)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

// =============================================================================================

describe('reading an order', () => {
  it('only an explicit wipe with a numeric order counts', () => {
    expect(wipeOrderOf({ enforced: true, deviceStatus: 'REVOKED', wipe: true, wipeOrderedAt: ORDERED_AT })).toBe(ORDERED_AT)
    expect(wipeOrderOf({ enforced: false, deviceStatus: 'REVOKED', wipe: true, wipeOrderedAt: ORDERED_AT })).toBe(ORDERED_AT)
    expect(wipeOrderOf({ enforced: true, deviceStatus: 'REVOKED' })).toBeNull()
    expect(wipeOrderOf({ enforced: true, deviceStatus: 'REVOKED', wipe: 'true' as never, wipeOrderedAt: ORDERED_AT })).toBeNull()
    expect(wipeOrderOf({ enforced: true, deviceStatus: 'REVOKED', wipe: true })).toBeNull()
    expect(wipeOrderOf({ enforced: true, deviceStatus: 'REVOKED', wipe: true, wipeOrderedAt: '1' as never })).toBeNull()
    expect(wipeOrderOf(null)).toBeNull()
  })
})

describe('asking the server', () => {
  it('does nothing without an enrolled identity — nothing to ask with', async () => {
    expect(await checkForWipeOrder(deps())).toBe('none')
    expect(fetchChallenge).not.toHaveBeenCalled()
    expect(readWipeMarker(deps())).toBeNull()
  })

  it('does nothing offline, or when the server says anything but an order', async () => {
    await enrolledIdentity()
    fetchChallenge.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await checkForWipeOrder(deps())).toBe('none')
    fetchChallenge.mockResolvedValueOnce({ enforced: true, deviceStatus: 'REVOKED' })
    expect(await checkForWipeOrder(deps())).toBe('none')
    expect(reload).not.toHaveBeenCalled()
    expect(readWipeMarker(deps())).toBeNull()
  })

  it('asks with this device id and its fingerprint, and on an order records it and reloads', async () => {
    await enrolledIdentity()
    fetchChallenge.mockResolvedValueOnce({ enforced: false, deviceStatus: 'REVOKED', wipe: true, wipeOrderedAt: ORDERED_AT })

    expect(await checkForWipeOrder(deps())).toBe('wiping')

    expect(fetchChallenge).toHaveBeenCalledWith(DEVICE_ID, FINGERPRINT)
    expect(readWipeMarker(deps())).toMatchObject({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT, stage: 'wiping' })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    // Nothing is deleted yet: that waits for the start after the reload, before the database opens.
    expect(await loadIdentity()).not.toBeNull()
  })
})

describe('carrying it out, before the database opens', () => {
  it('without a marker does nothing at all', async () => {
    await seedLocalWork()
    db.close()
    expect(await resumeDeviceWipe(deps())).toBe('none')
    await openDatabase()
    expect(await db.logSheets.count()).toBe(1)
  })

  it('deletes every round, photo, archive, fault report, list and the session — and keeps the server address', async () => {
    await enrolledIdentity()
    await seedLocalWork()
    db.close()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())

    expect(await resumeDeviceWipe(deps())).toBe('wiped')

    await openDatabase()
    for (const table of ['logSheets', 'attachments', 'logSheetUserArchives', 'nfcFaultReports', 'lookupLists', 'lookupItems', 'syncMeta']) {
      expect(await db.table(table).count(), table).toBe(0)
    }
    // Storage areas: everything gone but the marker, now waiting to confirm.
    expect(local.getItem('some.app.key')).toBeNull()
    expect(session.getItem('some.session.key')).toBeNull()
    expect(readWipeMarker(deps())).toMatchObject({ stage: 'confirming', serverUrl: 'https://logsheet.plant.example' })
    // The key is set aside for the confirmation, so the tablet is no longer enrolled.
    expect(await loadIdentity()).toBeNull()
    expect((await loadRetiredIdentity())?.requestId).toBe(DEVICE_ID)

    await restoreServerUrlAfterWipe(async serverUrl => saveSettings({ ...(await getSettings()), serverUrl }), deps())
    expect((await getSettings()).serverUrl).toBe('https://logsheet.plant.example')
    expect(readWipeMarker(deps())?.serverUrl).toBeUndefined()
  })

  it('says so once on the login page', async () => {
    await enrolledIdentity()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())
    await resumeDeviceWipe(deps())

    expect(session.getItem(WIPED_NOTICE_KEY)).toBe('1')
    expect(takeWipedNotice(deps())).toBe(true)
    expect(takeWipedNotice(deps())).toBe(false)
  })

  it('a database another copy of the app will not let go of blocks the start, and the next start finishes', async () => {
    await enrolledIdentity()
    await seedLocalWork()
    db.close()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())

    const blocked = deps({ deleteMainDatabase: () => Promise.reject(new Error('blocked')) })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await resumeDeviceWipe(blocked)).toBe('blocked')
    expect(readWipeMarker(deps())?.stage).toBe('wiping')

    expect(await resumeDeviceWipe(deps())).toBe('wiped')
    await openDatabase()
    expect(await db.logSheets.count()).toBe(0)
    // The key was set aside on the first, interrupted run and is still there for the confirmation.
    expect((await loadRetiredIdentity())?.requestId).toBe(DEVICE_ID)
  })

  it('an order already carried out is never carried out twice — the tablet may hold new work by then', async () => {
    await enrolledIdentity()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())
    await resumeDeviceWipe(deps())
    confirm.mockRejectedValue(new ApiError(0, 'offline'))
    await seedLocalWork() // new work after the wipe, the confirmation still owed
    reload.mockClear()

    expect(await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())).toBe('already-wiped')
    expect(reload).not.toHaveBeenCalled()
    expect(await db.logSheets.count()).toBe(1)
    expect(readWipeMarker(deps())?.stage).toBe('confirming')
  })
})

describe('the confirmation', () => {
  async function wiped(): Promise<void> {
    await enrolledIdentity()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())
    await resumeDeviceWipe(deps())
  }

  it('is signed with the set-aside key over exactly the order, and then the key is let go', async () => {
    await wiped()
    const signed: string[] = []
    const result = await confirmPendingWipe(deps({
      sign: async (identity, message) => {
        signed.push(message)
        expect(identity.requestId).toBe(DEVICE_ID)
        return 'SIG'
      }
    }))

    expect(result).toBe('confirmed')
    expect(signed).toEqual([wipeMessage(DEVICE_ID, ORDERED_AT)])
    expect(confirm).toHaveBeenCalledWith(DEVICE_ID, ORDERED_AT, 'SIG')
    expect(await loadRetiredIdentity()).toBeNull()
    expect(local.getItem(WIPE_MARKER_KEY)).toBeNull()
  })

  it('is kept for the next try when the server cannot be reached, answers 5xx, 408 or 429', async () => {
    await wiped()
    for (const failure of [new ApiError(0, 'offline'), new ApiError(503, 'down'), new ApiError(408, 'slow'), new ApiError(429, 'limited')]) {
      confirm.mockRejectedValueOnce(failure)
      expect(await confirmPendingWipe(deps())).toBe('retry')
      expect(readWipeMarker(deps())?.stage).toBe('confirming')
      expect(await loadRetiredIdentity()).not.toBeNull()
    }
    expect(await confirmPendingWipe(deps())).toBe('confirmed')
  })

  it('is let go when the server refuses it for good — nothing more could ever be proved', async () => {
    await wiped()
    confirm.mockRejectedValueOnce(new ApiError(409, 'no such order', { code: 'WIPE_ORDER_UNKNOWN' }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await confirmPendingWipe(deps())).toBe('confirmed')
    expect(await loadRetiredIdentity()).toBeNull()
    expect(readWipeMarker(deps())).toBeNull()
  })

  it('does nothing without a pending wipe, and gives up quietly without a key to sign with', async () => {
    expect(await confirmPendingWipe(deps())).toBe('none')
    await wiped()
    await discardRetiredIdentity()
    expect(await confirmPendingWipe(deps())).toBe('none')
    expect(confirm).not.toHaveBeenCalled()
    expect(readWipeMarker(deps())).toBeNull()
  })

  it('one at a time, however many callers ask', async () => {
    await wiped()
    let release!: () => void
    confirm.mockImplementationOnce(() => new Promise(r => { release = () => r({}) }))
    const first = confirmPendingWipe(deps())
    const second = confirmPendingWipe(deps())
    expect(second).toBe(first)
    await new Promise(r => setTimeout(r, 5))
    release()
    await first
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('a real WebCrypto signature from the set-aside key verifies against the enrolled public key', async () => {
    await wiped()
    const key = await loadRetiredIdentity()
    let signature = ''
    confirm.mockImplementationOnce(async (_d: number, _o: number, s: string) => { signature = s; return {} })
    await confirmPendingWipe(deps())

    const publicKey = await crypto.subtle.importKey(
      'spki', Uint8Array.from(atob(key!.publicKey), c => c.charCodeAt(0)),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey,
      Uint8Array.from(atob(signature), c => c.charCodeAt(0)),
      new TextEncoder().encode(wipeMessage(DEVICE_ID, ORDERED_AT)))
    expect(ok).toBe(true)
  })
})

describe('after the wipe', () => {
  it('a new enrolment starts from a new key while the old one still owes its confirmation', async () => {
    await enrolledIdentity()
    await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps())
    await resumeDeviceWipe(deps())

    const fresh = await createIdentity('tablet 7, again')
    expect(fresh.id).toBe('device')
    expect((await loadRetiredIdentity())?.requestId).toBe(DEVICE_ID)

    // The fresh identity is not enrolled, so nothing is asked and nothing is wiped again.
    expect(await checkForWipeOrder(deps())).toBe('none')
    expect(fetchChallenge).not.toHaveBeenCalled()
  })
})

describe('with no storage that survives a reload', () => {
  it('deletes at once rather than leave data an administrator ordered removed', async () => {
    await enrolledIdentity()
    await seedLocalWork()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const outcome = await beginDeviceWipe({ deviceId: DEVICE_ID, wipeOrderedAt: ORDERED_AT }, deps({ local: () => null }))

    expect(outcome).toBe('wiping')
    await openDatabase()
    expect(await db.logSheets.count()).toBe(0)
    expect(await loadIdentity()).toBeNull()
  })
})

// =============================================================================================
// The signed-in check (useDeviceStatusWatch) — a revoke that never answered this session with 401
// =============================================================================================

describe('checkDeviceStatus', () => {
  it('without an enrolled identity asks nothing', async () => {
    const { checkDeviceStatus } = await import('./deviceWipe')
    expect(await checkDeviceStatus(deps())).toBe('none')
    expect(fetchChallenge).not.toHaveBeenCalled()
  })

  it('a wipe order is carried out exactly as at the login page — enrolment on or off', async () => {
    const { checkDeviceStatus } = await import('./deviceWipe')
    await enrolledIdentity()
    fetchChallenge.mockResolvedValueOnce({ enforced: false, deviceStatus: 'REVOKED', wipe: true, wipeOrderedAt: ORDERED_AT })

    expect(await checkDeviceStatus(deps())).toBe('wiping')
    expect(readWipeMarker(deps())?.stage).toBe('wiping')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a revoke under enforced enrolment is reported, so the session can be ended', async () => {
    const { checkDeviceStatus } = await import('./deviceWipe')
    await enrolledIdentity()
    fetchChallenge.mockResolvedValueOnce({ enforced: true, deviceStatus: 'REVOKED' })

    expect(await checkDeviceStatus(deps())).toBe('revoked')
    expect(reload).not.toHaveBeenCalled()
    expect(readWipeMarker(deps())).toBeNull()
  })

  it('with enrolment off a plain revoke says nothing — it stops no login, so signing out would only send them back', async () => {
    const { checkDeviceStatus } = await import('./deviceWipe')
    await enrolledIdentity()
    fetchChallenge.mockResolvedValueOnce({ enforced: false })
    expect(await checkDeviceStatus(deps())).toBe('none')
  })

  it('an approved, pending or unknown device, or no answer at all, is left alone', async () => {
    const { checkDeviceStatus } = await import('./deviceWipe')
    await enrolledIdentity()
    for (const answer of [
      { enforced: true, deviceStatus: 'APPROVED' as const, nonce: 'n' },
      { enforced: true, deviceStatus: 'PENDING' as const },
      { enforced: true, deviceStatus: 'UNKNOWN' as const }
    ]) {
      fetchChallenge.mockResolvedValueOnce(answer)
      expect(await checkDeviceStatus(deps())).toBe('none')
    }
    fetchChallenge.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await checkDeviceStatus(deps())).toBe('none')
    expect(reload).not.toHaveBeenCalled()
  })
})
