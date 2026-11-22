import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordServerTimeSample, resetServerClockForTests, serverNow } from './serverClock'
import {
  canSubmitLogSheet,
  isExpiredDraft,
  isLogSheetExpired,
  isReopenedAfterSync
} from '@/utils/logSheetStatus'
import { canContinueReopenedLogSheet } from '@/utils/logSheetWorkflow'
import { isSessionValid, type AuthSession } from '@/types/auth'
import { isUndeliveredRound } from '@/services/sync/undelivered'
import { isEligibleForLocalPurge } from '@/services/sync/cleanupLogSheets'
import { toBatchPayload } from '@/services/sync/logSheetSync'
import type { LogSheet } from '@/types'
import type { ServerLogSheet } from '@/services/api'

/**
 * PWA roadmap §7 — every decision taken against a server time now uses the server's clock.
 *
 * Each case puts this device's clock somewhere wrong (fast, slow, set back) and checks that the
 * decision comes out as it would on a correct clock. Before §7 every one of these was decided on
 * `Date.now()`, and a tablet whose clock nobody corrects got them wrong.
 */

const HOUR = 3_600_000
const SERVER = 1_800_000_000_000

/** Measure the clock as running `skewMs` ahead of the server (negative: behind). */
function deviceClockOff(skewMs: number): void {
  recordServerTimeSample(SERVER, SERVER + skewMs, SERVER + skewMs)
}

function sheet(overrides: Partial<LogSheet>): LogSheet {
  return {
    localId: 'l-1',
    serverId: '10',
    templateId: '1',
    templateName: 'T',
    scopeSummary: '',
    status: 'draft',
    syncStatus: 'pending',
    entries: [],
    createdAt: SERVER - HOUR,
    updatedAt: SERVER - HOUR,
    ...overrides
  } as LogSheet
}

beforeEach(() => resetServerClockForTests())
afterEach(() => resetServerClockForTests())

describe('a deadline, on a device clock running two hours fast', () => {
  const realNow = () => Date.now()

  it('is not passed when the server says it has not', () => {
    // The server's time is "now"; the device reads two hours later.
    const deviceNow = realNow()
    recordServerTimeSample(deviceNow - 2 * HOUR, deviceNow, deviceNow)
    const dueInAnHour = sheet({ dueAt: deviceNow - 2 * HOUR + HOUR })

    expect(isLogSheetExpired(dueInAnHour)).toBe(false)
    expect(isExpiredDraft(dueInAnHour)).toBe(false)
    expect(canSubmitLogSheet(dueInAnHour).ok).toBe(true)
  })
})

describe('a deadline, on a device clock running two hours slow', () => {
  it('is passed when the server says it has', () => {
    const deviceNow = Date.now()
    recordServerTimeSample(deviceNow + 2 * HOUR, deviceNow, deviceNow)
    const dueAnHourAgo = sheet({ dueAt: deviceNow + HOUR })

    expect(isLogSheetExpired(dueAnHourAgo)).toBe(true)
    expect(canSubmitLogSheet(dueAnHourAgo).ok).toBe(false)
  })
})

describe('a device clock set back after the last sync', () => {
  it('cannot reopen a deadline the server had already seen pass', () => {
    const deviceNow = Date.now()
    // In sync with the server at the last answer…
    recordServerTimeSample(deviceNow, deviceNow, deviceNow)
    const dueJustBefore = sheet({ dueAt: deviceNow - 60_000 })
    // …then the clock is set back by a day: serverNow() stays at the floor.
    expect(serverNow(deviceNow - 24 * HOUR)).toBe(deviceNow)
    expect(isLogSheetExpired(dueJustBefore, serverNow(deviceNow - 24 * HOUR))).toBe(true)
  })
})

describe('a session', () => {
  const session = (expiresAt: number): AuthSession =>
    ({ accessToken: 't', tokenType: 'Bearer', expiresAt, username: 'u', fullName: 'U', roles: [], permissions: [] }) as AuthSession

  it('is not dropped on a reachable server because the device clock is past its expiry', () => {
    const deviceNow = Date.now()
    // The device runs 10 hours fast; the token has 7 hours left on the server's clock.
    recordServerTimeSample(deviceNow - 10 * HOUR, deviceNow, deviceNow)
    const fresh = session(deviceNow - 10 * HOUR + 7 * HOUR)
    vi.stubGlobal('navigator', { onLine: true })
    try {
      expect(isSessionValid(fresh, undefined, true)).toBe(true)
      expect(isSessionValid(fresh, deviceNow, true)).toBe(false) // the old behaviour, for contrast
      // And a token that really has expired on the server's clock is still dropped.
      expect(isSessionValid(session(deviceNow - 10 * HOUR - HOUR), undefined, true)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('a reopened round', () => {
  it('is still open when its new deadline is ahead on the server clock', () => {
    const deviceNow = Date.now()
    recordServerTimeSample(deviceNow - 3 * HOUR, deviceNow, deviceNow)
    const reopened = sheet({ status: 'submitted', syncStatus: 'synced', serverStatus: 'IN_PROGRESS', dueAt: deviceNow - HOUR })
    expect(isReopenedAfterSync(reopened)).toBe(true)
    const server = { status: 'IN_PROGRESS', assigneeUserId: 7, dueAt: deviceNow - HOUR } as unknown as ServerLogSheet
    expect(canContinueReopenedLogSheet(server, '7').ok).toBe(true)
  })
})

describe('the local purge', () => {
  const windows = { syncedMs: 24 * HOUR, failedMs: null, expiredDraftMs: null }

  it('keeps a reopened round on a fast clock — the guard takes the server clock, the retention age the device clock', () => {
    const deviceNow = SERVER + 5 * HOUR
    deviceClockOff(5 * HOUR)
    // Synced long ago by device stamps, reopened with a deadline one hour ahead on the server.
    const reopened = sheet({
      status: 'submitted', syncStatus: 'synced', serverStatus: 'IN_PROGRESS',
      syncedAt: deviceNow - 48 * HOUR, dueAt: SERVER + HOUR
    })
    expect(isEligibleForLocalPurge(reopened, deviceNow, windows)).toBe(false)
  })

  it('still purges an old synced round by its device-clock age', () => {
    const deviceNow = SERVER + 5 * HOUR
    deviceClockOff(5 * HOUR)
    const old = sheet({ status: 'submitted', syncStatus: 'synced', syncedAt: deviceNow - 48 * HOUR })
    expect(isEligibleForLocalPurge(old, deviceNow, windows)).toBe(true)
  })
})

describe('an undelivered round', () => {
  it('is judged on the server clock', () => {
    const deviceNow = Date.now()
    recordServerTimeSample(deviceNow + 2 * HOUR, deviceNow, deviceNow)
    const draftWithEditsPastDue = sheet({
      dueAt: deviceNow + HOUR,
      entries: [{ assetId: '1', formData: { a: 1 }, locallyEditedAt: deviceNow - HOUR } as never]
    })
    expect(isUndeliveredRound(draftWithEditsPastDue)).toBe(true)
  })
})

describe('the completion sent to the server', () => {
  it('carries the clock correction that went into it, and only when one was recorded', () => {
    const base = sheet({ status: 'submitted', completedAt: SERVER, submittedAt: SERVER, clientActionId: 'k' })
    expect(toBatchPayload({ ...base, completionClockOffsetMs: -7_200_000 }).clientClockOffsetMs).toBe(-7_200_000)
    expect(toBatchPayload(base)).not.toHaveProperty('clientClockOffsetMs')
    expect(toBatchPayload({ ...base, completionClockOffsetMs: 0 }).clientClockOffsetMs).toBe(0)
  })

  it('a round with no recorded completion time falls back to the server clock, not the device clock', () => {
    const deviceNow = Date.now()
    recordServerTimeSample(deviceNow - 2 * HOUR, deviceNow, deviceNow)
    const payload = toBatchPayload(sheet({ status: 'submitted', clientActionId: 'k' }))
    expect(payload.completedAt).toBeLessThan(deviceNow - HOUR)
  })
})
