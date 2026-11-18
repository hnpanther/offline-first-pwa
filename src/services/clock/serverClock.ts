/**
 * The server's clock, as this device last measured it — PWA roadmap §7, backend issue B-17.
 *
 * <h2>Why the device clock is not enough</h2>
 *
 * Every deadline is the server's time (`dueAt`, a token's `expiresAt`), and the server judges a
 * round's completion on the time the tablet says it finished (`completedAt`). On a plant network
 * with no internet route nothing corrects a tablet's clock, and after a full battery drain it can be
 * anything. A clock running fast made on-time work late; one running slow let late work through.
 *
 * <h2>What this keeps</h2>
 *
 * One offset — `server − device` — measured on every response that carries the server's time (sign
 * in, bootstrap, the inbox): `offset = serverTime − (sentAt + receivedAt) / 2`. Its error is at most
 * half the round trip, and a sample whose round trip is longer than {@link MAX_SAMPLE_RTT_MS} is
 * refused rather than trusted. The newest accepted sample wins: after a clock change the old offset
 * is exactly the wrong one. It is persisted, so it survives going offline and a restart.
 *
 * <h2>The floor</h2>
 *
 * {@link serverNow} never answers earlier than the server time last seen. Time does not run
 * backwards, so «now» is at least that — and a device clock set back after the last sync (by a flat
 * battery, or by somebody hiding a late round) cannot carry the app to before it. What the floor
 * cannot do is notice a clock set back by less than the time since the last sync; the server's own
 * check (B-17) and the offline-session ceiling are the other two layers.
 *
 * <h2>What is NOT on this clock</h2>
 *
 * Durations measured on the device (a recording's length, a timer), and the device's own bookkeeping
 * stamps that are only ever compared with each other (retention ages, `locallyEditedAt`, an entry's
 * `createdAt`/`updatedAt` that the server echoes back as a concurrency base). Moving any of those to
 * server time would compare two clocks; see AGENTS.md.
 *
 * <h2>Before the first measurement</h2>
 *
 * The offset is 0 and there is no floor — exactly the behaviour before this module existed.
 */

/** A sample whose round trip took longer than this is too uncertain to set the clock by. */
export const MAX_SAMPLE_RTT_MS = 30_000

/**
 * A server time before this is not a server time (2020-01-01). Guards against a missing or zero
 * field being read as «the server says it is 1970».
 */
const EARLIEST_PLAUSIBLE_SERVER_TIME = 1_577_836_800_000

export interface ServerClockState {
  /** Server minus device, in milliseconds. Positive: this device's clock is behind. */
  offsetMs: number
  /** The round trip of the sample the offset came from. */
  rttMs: number
  /** Device time when that sample was taken. */
  measuredAt: number
  /** The server's own time in the newest accepted sample — the floor under {@link serverNow}. */
  serverTimeSeen: number
}

let state: ServerClockState | null = null

/**
 * Where an accepted sample is written. Injected by `serverClockStore.ts` rather than imported:
 * the deadline helpers read this module, the database module reads those, and a direct import of
 * the database here would close that circle.
 */
let persister: ((value: ServerClockState) => Promise<void>) | null = null

export function setServerClockPersister(next: ((value: ServerClockState) => Promise<void>) | null): void {
  persister = next
}

function isPlausibleServerTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= EARLIEST_PLAUSIBLE_SERVER_TIME
}

function isState(value: unknown): value is ServerClockState {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.offsetMs === 'number' && Number.isFinite(v.offsetMs) &&
    typeof v.rttMs === 'number' && Number.isFinite(v.rttMs) &&
    typeof v.measuredAt === 'number' && Number.isFinite(v.measuredAt) &&
    isPlausibleServerTime(v.serverTimeSeen)
  )
}

/** What this device knows about the server's clock, or `null` before the first measurement. */
export function currentServerClock(): ServerClockState | null {
  return state ? { ...state } : null
}

/** Server minus device, in milliseconds; 0 before the first measurement. */
export function clockOffsetMs(): number {
  return state?.offsetMs ?? 0
}

/** The server time last seen, or `null` before the first measurement. */
export function lastServerTimeSeen(): number | null {
  return state?.serverTimeSeen ?? null
}

/**
 * The device clock corrected by the last measured offset — **without** the floor. For a check
 * that must notice a clock set back (the offline-session ceiling): the floor would hide exactly
 * that.
 */
export function rawServerNow(deviceNow: number = Date.now()): number {
  return deviceNow + clockOffsetMs()
}

/**
 * The best estimate of the server's «now» — for every decision taken against a server time
 * (`dueAt`, `expiresAt`) and for every time this device reports as when something happened
 * (`completedAt`). Never earlier than the server time last seen.
 */
export function serverNow(deviceNow: number = Date.now()): number {
  const raw = rawServerNow(deviceNow)
  const floor = state?.serverTimeSeen
  return floor != null && floor > raw ? floor : raw
}

/**
 * Records one measurement: the server said `serverTime` in a response to a request sent at
 * `sentAt` and answered at `receivedAt` (both device time).
 *
 * @returns whether the sample was accepted. Refused: no plausible server time, a round trip that is
 *          negative (the device clock moved during the request) or longer than {@link
 *          MAX_SAMPLE_RTT_MS}.
 */
export function recordServerTimeSample(serverTime: unknown, sentAt: number, receivedAt: number): boolean {
  if (!isPlausibleServerTime(serverTime)) return false
  if (!Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) return false
  const rttMs = receivedAt - sentAt
  if (rttMs < 0 || rttMs > MAX_SAMPLE_RTT_MS) return false

  const midpoint = sentAt + rttMs / 2
  state = {
    offsetMs: Math.round(serverTime - midpoint),
    rttMs,
    measuredAt: receivedAt,
    serverTimeSeen: serverTime
  }
  void persist(state)
  return true
}

async function persist(value: ServerClockState): Promise<void> {
  if (!persister) return
  try {
    await persister(value)
  } catch (err) {
    // Not fatal: the in-memory clock still serves this session, and the next sample tries again.
    console.warn('[clock] could not persist the server clock', err)
  }
}

/**
 * Adopts a stored measurement. Anything that is not a well-formed one is ignored — the app then
 * runs on the device clock until the next measurement, as it always did.
 *
 * @returns whether the value was adopted
 */
export function adoptStoredServerClock(value: unknown): boolean {
  if (!isState(value)) {
    state = null
    return false
  }
  state = { ...value }
  return true
}

/**
 * Times a request and records the `serverTime` its answer carries. For the three calls that carry
 * one (sign in, bootstrap, the inbox); a failed request records nothing and is rethrown untouched.
 */
export async function measuredRequest<T extends { serverTime?: unknown }>(
  send: () => Promise<T>,
  deviceNow: () => number = Date.now
): Promise<T> {
  const sentAt = deviceNow()
  const response = await send()
  recordServerTimeSample(response?.serverTime, sentAt, deviceNow())
  return response
}

/** Tests only: forget everything, in memory. */
export function resetServerClockForTests(next: ServerClockState | null = null): void {
  state = next ? { ...next } : null
}
