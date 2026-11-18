import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SAMPLE_RTT_MS,
  adoptStoredServerClock,
  clockOffsetMs,
  currentServerClock,
  lastServerTimeSeen,
  measuredRequest,
  rawServerNow,
  recordServerTimeSample,
  resetServerClockForTests,
  serverNow,
  setServerClockPersister
} from './serverClock'
import { loadServerClock, SERVER_CLOCK_META_KEY } from './serverClockStore'
import { db } from '@/services/storage/db'

/**
 * PWA roadmap §7 — the server's clock as this device measures it.
 *
 * Every deadline decision and every completion time now goes through these few functions, so a
 * mistake here moves every round on every tablet. The cases are the arithmetic, the samples that
 * must be refused, the floor that a clock set back cannot get under, and the persistence that lets
 * a tablet carry the correction offline.
 */

const SERVER = 1_800_000_000_000 // 2027-01-15, a plausible server time
const HOUR = 3_600_000

beforeEach(() => {
  resetServerClockForTests()
  setServerClockPersister(null)
})

afterEach(() => {
  resetServerClockForTests()
  setServerClockPersister(null)
})

describe('before the first measurement', () => {
  it('is exactly the device clock — the behaviour before this existed', () => {
    expect(clockOffsetMs()).toBe(0)
    expect(currentServerClock()).toBeNull()
    expect(lastServerTimeSeen()).toBeNull()
    expect(serverNow(12_345)).toBe(12_345)
    expect(rawServerNow(12_345)).toBe(12_345)
  })
})

describe('a sample', () => {
  it('sets the offset from the midpoint of the round trip', () => {
    // The device clock runs two hours fast: it reads SERVER + 2h when the server reads SERVER.
    const sentAt = SERVER + 2 * HOUR - 200
    const receivedAt = SERVER + 2 * HOUR + 200
    expect(recordServerTimeSample(SERVER, sentAt, receivedAt)).toBe(true)

    expect(clockOffsetMs()).toBe(-2 * HOUR)
    expect(currentServerClock()).toMatchObject({ rttMs: 400, measuredAt: receivedAt, serverTimeSeen: SERVER })
    expect(serverNow(SERVER + 3 * HOUR)).toBe(SERVER + HOUR)
  })

  it('a slow device clock gives a positive offset', () => {
    recordServerTimeSample(SERVER, SERVER - 30 * 60_000, SERVER - 30 * 60_000)
    expect(clockOffsetMs()).toBe(30 * 60_000)
    expect(serverNow(SERVER)).toBe(SERVER + 30 * 60_000)
  })

  it('the newest accepted sample wins — after a clock change the old offset is the wrong one', () => {
    recordServerTimeSample(SERVER, SERVER - HOUR, SERVER - HOUR)
    expect(clockOffsetMs()).toBe(HOUR)
    recordServerTimeSample(SERVER + 60_000, SERVER + 60_000, SERVER + 60_000)
    expect(clockOffsetMs()).toBe(0)
  })

  it.each([
    ['a missing server time', undefined],
    ['null', null],
    ['zero', 0],
    ['a string', '1800000000000'],
    ['NaN', Number.NaN],
    ['a time before 2020', 1_000_000_000_000]
  ])('refuses %s and keeps what it had', (_label, serverTime) => {
    recordServerTimeSample(SERVER, SERVER, SERVER)
    expect(recordServerTimeSample(serverTime, SERVER, SERVER + 10)).toBe(false)
    expect(clockOffsetMs()).toBe(0)
    expect(lastServerTimeSeen()).toBe(SERVER)
  })

  it('refuses a round trip too long to trust, and one that ran backwards', () => {
    expect(recordServerTimeSample(SERVER, SERVER, SERVER + MAX_SAMPLE_RTT_MS + 1)).toBe(false)
    expect(recordServerTimeSample(SERVER, SERVER, SERVER - 1)).toBe(false)
    expect(currentServerClock()).toBeNull()
    expect(recordServerTimeSample(SERVER, SERVER, SERVER + MAX_SAMPLE_RTT_MS)).toBe(true)
  })
})

describe('the floor', () => {
  it('never answers earlier than the server time last seen — a clock set back after the sync cannot go under it', () => {
    recordServerTimeSample(SERVER, SERVER, SERVER)
    // Battery drained, clock reset to the epoch.
    expect(serverNow(0)).toBe(SERVER)
    // Set back by a day to hide a late round.
    expect(serverNow(SERVER - 24 * HOUR)).toBe(SERVER)
    // Moving forward is followed normally.
    expect(serverNow(SERVER + 5 * HOUR)).toBe(SERVER + 5 * HOUR)
  })

  it('the raw reading has no floor, so a check that must notice a clock set back can', () => {
    recordServerTimeSample(SERVER, SERVER, SERVER)
    expect(rawServerNow(SERVER - 24 * HOUR)).toBe(SERVER - 24 * HOUR)
  })
})

describe('measuredRequest', () => {
  it('times the request and records the server time its answer carries', async () => {
    const times = [SERVER + HOUR, SERVER + HOUR + 100]
    const answer = await measuredRequest(async () => ({ serverTime: SERVER, payload: 'x' }), () => times.shift()!)
    expect(answer.payload).toBe('x')
    expect(clockOffsetMs()).toBe(-HOUR - 50)
  })

  it('records nothing from an answer without a server time (an older server)', async () => {
    await measuredRequest(async () => ({ accessToken: 't' }) as { serverTime?: number })
    expect(currentServerClock()).toBeNull()
  })

  it('records nothing and rethrows when the request fails', async () => {
    await expect(measuredRequest(async () => { throw new Error('down') })).rejects.toThrow('down')
    expect(currentServerClock()).toBeNull()
  })
})

describe('persistence', () => {
  it('writes every accepted sample through the persister, and none that was refused', async () => {
    const persister = vi.fn(async () => undefined)
    setServerClockPersister(persister)
    recordServerTimeSample(SERVER, SERVER, SERVER)
    recordServerTimeSample(0, SERVER, SERVER)
    expect(persister).toHaveBeenCalledTimes(1)
  })

  it('a persister that fails costs nothing but the write', async () => {
    setServerClockPersister(async () => { throw new Error('quota') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(recordServerTimeSample(SERVER, SERVER, SERVER)).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(clockOffsetMs()).toBe(0)
    expect(lastServerTimeSeen()).toBe(SERVER)
    warn.mockRestore()
  })

  it('survives a restart through syncMeta', async () => {
    await db.syncMeta.delete(SERVER_CLOCK_META_KEY)
    await loadServerClock()
    expect(currentServerClock()).toBeNull()

    recordServerTimeSample(SERVER, SERVER + HOUR, SERVER + HOUR)
    await new Promise(r => setTimeout(r, 10))
    resetServerClockForTests()

    await loadServerClock()
    expect(clockOffsetMs()).toBe(-HOUR)
    expect(lastServerTimeSeen()).toBe(SERVER)
  })

  it('ignores a stored row that is not a measurement', () => {
    expect(adoptStoredServerClock({ offsetMs: 'soon' })).toBe(false)
    expect(adoptStoredServerClock({ offsetMs: 1, rttMs: 1, measuredAt: 1, serverTimeSeen: 5 })).toBe(false)
    expect(currentServerClock()).toBeNull()
    expect(adoptStoredServerClock({ offsetMs: 1, rttMs: 1, measuredAt: 1, serverTimeSeen: SERVER })).toBe(true)
    expect(clockOffsetMs()).toBe(1)
  })
})
