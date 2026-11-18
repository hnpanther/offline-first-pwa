import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_MS,
  DEFAULT_OFFLINE_SESSION_HOURS,
  clearSessionContact,
  currentOfflineSessionVerdict,
  evaluateOfflineSession,
  lastServerContact,
  loadSessionContact,
  markSessionStarted,
  normalizeOfflineSessionLimit,
  noteAuthenticatedContact,
  resetOfflineSessionForTests
} from './offlineSession'
import { recordServerTimeSample, resetServerClockForTests } from '@/services/clock/serverClock'
import { isFillRoute, mayInterrupt } from '@/hooks/useOfflineSessionGuard'
import { db } from '@/services/storage/db'

/**
 * Backend V28 — the offline-session ceiling.
 *
 * A wrong verdict here either locks an operator out in a dead zone (too eager) or leaves a stolen
 * tablet signed in (too lax), so every edge is pinned: off, never contacted, inside the ceiling,
 * the warning window, exactly at the ceiling, a clock set back — and the one rule that matters as
 * much as the arithmetic, that an open form is never interrupted by a timer.
 */

const HOUR = 3_600_000
const T0 = 1_800_000_000_000
const ON = { enabled: true, hours: 72 }

beforeEach(async () => {
  resetServerClockForTests()
  resetOfflineSessionForTests()
  await db.syncMeta.clear()
})

afterEach(() => {
  resetServerClockForTests()
  resetOfflineSessionForTests()
})

describe('normalizeOfflineSessionLimit', () => {
  it('keeps nothing when the server sent nothing — the device then never locks', () => {
    expect(normalizeOfflineSessionLimit(undefined)).toBeUndefined()
    expect(normalizeOfflineSessionLimit(null)).toBeUndefined()
  })

  it('reads the bootstrap block, and the switch only when exactly true', () => {
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: 24 })).toEqual({ enabled: true, hours: 24 })
    expect(normalizeOfflineSessionLimit({ limitEnabled: 'true', limitHours: 24 })?.enabled).toBe(false)
    expect(normalizeOfflineSessionLimit({ limitEnabled: 1, limitHours: 24 })?.enabled).toBe(false)
    expect(normalizeOfflineSessionLimit('garbage')).toEqual({ enabled: false, hours: DEFAULT_OFFLINE_SESSION_HOURS })
  })

  it('clamps the hours to a shift at least and a month at most; nonsense is the default, never zero', () => {
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: 1 })?.hours).toBe(8)
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: 10_000 })?.hours).toBe(720)
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: 0 })?.hours).toBe(72)
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: -5 })?.hours).toBe(72)
    expect(normalizeOfflineSessionLimit({ limitEnabled: true, limitHours: 'a day' })?.hours).toBe(72)
  })

  it('reads its own stored shape back the same', () => {
    expect(normalizeOfflineSessionLimit({ enabled: true, hours: 48 })).toEqual({ enabled: true, hours: 48 })
  })
})

describe('evaluateOfflineSession', () => {
  it('never locks with the ceiling off, absent, or with no contact recorded', () => {
    expect(evaluateOfflineSession(undefined, T0, T0 + 1000 * HOUR).locked).toBe(false)
    expect(evaluateOfflineSession({ enabled: false, hours: 8 }, T0, T0 + 1000 * HOUR).locked).toBe(false)
    expect(evaluateOfflineSession(ON, null, T0 + 1000 * HOUR).locked).toBe(false)
  })

  it('is open inside the ceiling and says how long is left', () => {
    const v = evaluateOfflineSession(ON, T0, T0 + 10 * HOUR)
    expect(v).toMatchObject({ locked: false, lockAt: T0 + 72 * HOUR, remainingMs: 62 * HOUR, warn: false })
  })

  it('warns within twelve hours of the lock', () => {
    expect(evaluateOfflineSession(ON, T0, T0 + 60 * HOUR - 1).warn).toBe(false)
    expect(evaluateOfflineSession(ON, T0, T0 + 60 * HOUR).warn).toBe(true)
  })

  it('warns within a quarter of a short ceiling rather than for its whole length', () => {
    const shift = { enabled: true, hours: 8 }
    expect(evaluateOfflineSession(shift, T0, T0 + 5 * HOUR).warn).toBe(false)
    expect(evaluateOfflineSession(shift, T0, T0 + 6 * HOUR).warn).toBe(true)
  })

  it('locks exactly at the ceiling', () => {
    expect(evaluateOfflineSession(ON, T0, T0 + 72 * HOUR - 1).locked).toBe(false)
    expect(evaluateOfflineSession(ON, T0, T0 + 72 * HOUR)).toMatchObject({ locked: true, reason: 'limit', remainingMs: 0 })
  })

  it('locks a clock set back before the last answer, beyond drift', () => {
    expect(evaluateOfflineSession(ON, T0, T0 - CLOCK_SKEW_MS).locked).toBe(false)
    expect(evaluateOfflineSession(ON, T0, T0 - CLOCK_SKEW_MS - 1)).toMatchObject({ locked: true, reason: 'clock' })
    // A flat battery that reset the clock to the epoch is the same case.
    expect(evaluateOfflineSession(ON, T0, 0)).toMatchObject({ locked: true, reason: 'clock' })
  })
})

describe('the last answer from the server', () => {
  it('a sign-in records it at once and on the server clock', async () => {
    recordServerTimeSample(T0, T0 + HOUR, T0 + HOUR) // device one hour fast
    await markSessionStarted(T0 + HOUR)
    expect(lastServerContact()).toBe(T0)
    resetOfflineSessionForTests()
    expect(await loadSessionContact()).toBe(T0)
  })

  it('an answer is recorded in memory at once and written at most once a minute', async () => {
    noteAuthenticatedContact(T0)
    await new Promise(r => setTimeout(r, 5))
    noteAuthenticatedContact(T0 + 30_000)
    await new Promise(r => setTimeout(r, 5))
    expect(lastServerContact()).toBe(T0 + 30_000)
    expect((await db.syncMeta.get('sessionLastContactAt'))?.value).toBe(T0)

    noteAuthenticatedContact(T0 + 61_000)
    await new Promise(r => setTimeout(r, 5))
    expect((await db.syncMeta.get('sessionLastContactAt'))?.value).toBe(T0 + 61_000)
  })

  it('a sign-out forgets it, in memory and on disk', async () => {
    await markSessionStarted(T0)
    await clearSessionContact()
    expect(lastServerContact()).toBeNull()
    expect(await db.syncMeta.get('sessionLastContactAt')).toBeUndefined()
  })

  it('a session with nothing recorded (an older build) starts its count now rather than locking', async () => {
    const v = await currentOfflineSessionVerdict(ON, T0)
    expect(v.locked).toBe(false)
    expect(lastServerContact()).toBe(T0)
  })

  it('the stored contact is what a restarted app counts from', async () => {
    await markSessionStarted(T0)
    resetOfflineSessionForTests()
    const v = await currentOfflineSessionVerdict(ON, T0 + 73 * HOUR)
    expect(v).toMatchObject({ locked: true, reason: 'limit' })
  })

  it('setting the clock forward to stretch the ceiling does not help, and setting it back locks', async () => {
    recordServerTimeSample(T0, T0, T0)
    await markSessionStarted(T0)
    expect((await currentOfflineSessionVerdict(ON, T0 + 80 * HOUR)).locked).toBe(true)
    expect((await currentOfflineSessionVerdict(ON, T0 - 24 * HOUR)).reason).toBe('clock')
  })
})

describe('the guard never interrupts a form', () => {
  it('knows the asset form from the lists', () => {
    expect(isFillRoute('/logsheets/abc-123')).toBe(true)
    expect(isFillRoute('/logsheets/abc-123/')).toBe(true)
    expect(isFillRoute('/logsheets/active')).toBe(false)
    expect(isFillRoute('/logsheets/history')).toBe(false)
    expect(isFillRoute('/')).toBe(false)
    expect(isFillRoute('/settings')).toBe(false)
  })

  it('a start or a navigation may lock anywhere; a timer or a return to the app not on the form', () => {
    expect(mayInterrupt('start', '/logsheets/abc')).toBe(true)
    expect(mayInterrupt('route', '/logsheets/abc')).toBe(true)
    expect(mayInterrupt('timer', '/logsheets/abc')).toBe(false)
    expect(mayInterrupt('visible', '/logsheets/abc')).toBe(false)
    expect(mayInterrupt('timer', '/')).toBe(true)
    expect(mayInterrupt('visible', '/logsheets/active')).toBe(true)
  })
})
