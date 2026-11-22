import Dexie from 'dexie'
import { ApiError } from '@/services/api/client'
import { confirmDeviceWipe, fetchLoginChallenge } from '@/services/api'
import { MAIN_DATABASE_NAME } from '@/services/storage/db'
import type { LoginChallengeResponse } from '@/types/device'
import {
  discardRetiredIdentity,
  loadIdentity,
  loadRetiredIdentity,
  retireIdentityForWipe,
  signMessage,
  wipeMessage,
  type DeviceIdentity
} from './deviceIdentity'

/**
 * Wipe on revoke — the tablet's half (backend V28; backend roadmap §42).
 *
 * <h2>What it is</h2>
 *
 * An administrator who revokes a device on `/devices` may also order it to delete everything this
 * app holds on it. The order reaches the tablet in the answer to `/api/auth/challenge`, the one
 * call it makes with its device identity and without a session, and the tablet asks it:
 *
 *  - when the login page opens (online, with an enrolled identity) — which is where a revoked
 *    tablet lands, because the revoke ended its session and the next request answered 401;
 *  - at every sign-in, inside `loginWithDevice`;
 *  - before this device would ever throw its key away (`startEnrollment` on a revoked key,
 *    `restartEnrollment`), because a discarded key can no longer be told anything.
 *
 * <h2>The one exception to «never discard local work»</h2>
 *
 * Everything else in this app is built so that a reading taken in the field is never lost. This
 * deletes rounds whose readings exist nowhere else, on purpose: the decision was an administrator's,
 * on a page that showed how many such rounds the tablet last reported. Nothing on the device decides
 * it, and nothing here runs without an order the server gave and the device's own identity received.
 *
 * <h2>How it survives being interrupted</h2>
 *
 * The order is written to `localStorage` first ({@link WIPE_MARKER_KEY}, stage `wiping`) and the app
 * reloads. The deletion itself runs in {@link resumeDeviceWipe}, from `main.tsx`, **before the
 * database is opened and before anything renders** — so no screen, sync tick or live query can hold
 * the database or write into it halfway. Killed in the middle, the next start finds the marker and
 * finishes. Then the stage becomes `confirming`: the device key is moved aside and signs the
 * server's confirmation ({@link confirmPendingWipe}), retried at every start and on the login page
 * until the server answers; a key the server will not accept is let go.
 *
 * <h2>What is deleted, and what is kept</h2>
 *
 * Deleted: the whole main database (`offline-pwa-db` — rounds, readings, the archive of other users'
 * rounds, photos, audio, video, signatures, NFC fault reports, reference lists, the inbox snapshot,
 * the session), every `localStorage` and `sessionStorage` key, and the device key once its
 * confirmation is accepted. Kept: the server address (so the tablet can reach the server to confirm
 * and be enrolled again) and the app itself — the service worker's cache holds the app's own files,
 * none of the plant's data.
 */

export const WIPE_MARKER_KEY = 'mfdcs.deviceWipe'
/** Set in `sessionStorage` once the data is gone, so the login page can say what happened. */
export const WIPED_NOTICE_KEY = 'mfdcs.deviceWiped'
export const WIPE_BROADCAST_CHANNEL = 'mfdcs-device-wipe'
/** How long the database deletion may wait on another open copy of the app before giving up. */
export const DELETE_TIMEOUT_MS = 15_000

export interface WipeOrder {
  /** The device id, which is the enrolment request number this device holds. */
  deviceId: number
  /** The order's identity on the server — signed back in the confirmation. */
  wipeOrderedAt: number
}

export interface WipeMarker extends WipeOrder {
  stage: 'wiping' | 'confirming'
  startedAt: number
  wipedAt?: number
  /** The server address, carried across the deletion so the fresh database can be given it back. */
  serverUrl?: string
}

/** Everything this module touches outside itself, injectable so every branch can be tested. */
export interface DeviceWipeDeps {
  local: () => Storage | null
  session: () => Storage | null
  reload: () => void
  broadcast: () => void
  now: () => number
  fetchChallenge: (deviceId: number, keyFingerprint: string) => Promise<LoginChallengeResponse>
  confirm: (deviceId: number, wipeOrderedAt: number, signature: string) => Promise<unknown>
  loadIdentity: () => Promise<DeviceIdentity | null>
  retireIdentity: () => Promise<boolean>
  loadRetiredIdentity: () => Promise<DeviceIdentity | null>
  discardRetiredIdentity: () => Promise<void>
  sign: (identity: DeviceIdentity, message: string) => Promise<string>
  readServerUrl: () => Promise<string | undefined>
  deleteMainDatabase: () => Promise<void>
}

function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const storage = (globalThis as Record<string, unknown>)[kind] as Storage | undefined
    return storage ?? null
  } catch {
    return null
  }
}

/** The server address in the main database, read without opening it at this app's schema. */
async function readStoredServerUrl(): Promise<string | undefined> {
  if (!(await Dexie.exists(MAIN_DATABASE_NAME))) return undefined
  const probe = new Dexie(MAIN_DATABASE_NAME)
  try {
    await probe.open()
    if (!probe.tables.some(t => t.name === 'settings')) return undefined
    const row = (await probe.table('settings').get('app')) as { serverUrl?: unknown } | undefined
    return typeof row?.serverUrl === 'string' && row.serverUrl.trim() ? row.serverUrl : undefined
  } finally {
    probe.close()
  }
}

export const defaultDeviceWipeDeps: DeviceWipeDeps = {
  local: () => browserStorage('localStorage'),
  session: () => browserStorage('sessionStorage'),
  reload: () => {
    window.location.replace('/login')
  },
  broadcast: () => {
    try {
      const channel = new BroadcastChannel(WIPE_BROADCAST_CHANNEL)
      channel.postMessage('wipe')
      channel.close()
    } catch {
      /* no BroadcastChannel: another open copy closes its database on the deletion anyway */
    }
  },
  now: () => Date.now(),
  fetchChallenge: (deviceId, keyFingerprint) => fetchLoginChallenge(deviceId, keyFingerprint),
  confirm: (deviceId, wipeOrderedAt, signature) => confirmDeviceWipe(deviceId, wipeOrderedAt, signature),
  loadIdentity,
  retireIdentity: retireIdentityForWipe,
  loadRetiredIdentity,
  discardRetiredIdentity,
  sign: signMessage,
  readServerUrl: readStoredServerUrl,
  deleteMainDatabase: () => Dexie.delete(MAIN_DATABASE_NAME)
}

// =============================================================================================
// The marker
// =============================================================================================

function isMarker(value: unknown): value is WipeMarker {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    (v.stage === 'wiping' || v.stage === 'confirming') &&
    typeof v.deviceId === 'number' && Number.isFinite(v.deviceId) &&
    typeof v.wipeOrderedAt === 'number' && Number.isFinite(v.wipeOrderedAt) &&
    typeof v.startedAt === 'number'
  )
}

export function readWipeMarker(deps: Pick<DeviceWipeDeps, 'local'> = defaultDeviceWipeDeps): WipeMarker | null {
  try {
    const raw = deps.local()?.getItem(WIPE_MARKER_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isMarker(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeMarker(marker: WipeMarker, deps: Pick<DeviceWipeDeps, 'local'>): boolean {
  try {
    const storage = deps.local()
    if (!storage) return false
    storage.setItem(WIPE_MARKER_KEY, JSON.stringify(marker))
    return storage.getItem(WIPE_MARKER_KEY) !== null
  } catch {
    return false
  }
}

function clearMarker(deps: Pick<DeviceWipeDeps, 'local'>): void {
  try {
    deps.local()?.removeItem(WIPE_MARKER_KEY)
  } catch {
    /* nothing to do */
  }
}

function sameOrder(a: WipeOrder, b: WipeOrder): boolean {
  return a.deviceId === b.deviceId && a.wipeOrderedAt === b.wipeOrderedAt
}

// =============================================================================================
// Receiving an order
// =============================================================================================

/** The wipe order in a challenge answer, or `null` when there is none. Exactly `true`, never truthy. */
export function wipeOrderOf(challenge: LoginChallengeResponse | null | undefined): number | null {
  if (!challenge || challenge.wipe !== true) return null
  const at = challenge.wipeOrderedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/**
 * What became of an order: `wiping` — the deletion is under way and the app is reloading, so the
 * caller must stop; `already-wiped` — this order was carried out on an earlier run, and only its
 * confirmation was retried; `none` — there is no order.
 */
export type WipeOutcome = 'none' | 'wiping' | 'already-wiped'

/**
 * Starts carrying out an order: records it, tells any other open copy of the app, and reloads so
 * the deletion runs before anything opens the database ({@link resumeDeviceWipe}).
 *
 * An order already carried out is not carried out twice — the tablet may have been enrolled again
 * and hold new work by the time the server repeats it — only its confirmation is retried.
 */
export async function beginDeviceWipe(order: WipeOrder, deps: DeviceWipeDeps = defaultDeviceWipeDeps): Promise<WipeOutcome> {
  const existing = readWipeMarker(deps)
  if (existing && sameOrder(existing, order)) {
    if (existing.stage === 'confirming') {
      void confirmPendingWipe(deps)
      return 'already-wiped'
    }
    deps.reload()
    return 'wiping'
  }

  const marker: WipeMarker = { ...order, stage: 'wiping', startedAt: deps.now() }
  if (!writeMarker(marker, deps)) {
    // No storage that survives a reload. Delete here and now instead: the order stands, and a
    // tablet with no localStorage is not a reason to keep data an administrator ordered removed.
    console.warn('[wipe] no persistent storage for the marker; wiping without a reload first')
    await runDeletion(marker, deps)
  }
  console.warn('[wipe] the server ordered this device wiped; deleting all local data', order)
  deps.broadcast()
  deps.reload()
  return 'wiping'
}

/**
 * Asks the server whether this device has a standing wipe order, and carries it out if so.
 * Safe to call at any time: without an enrolled identity, or offline, it does nothing.
 */
export async function checkForWipeOrder(deps: DeviceWipeDeps = defaultDeviceWipeDeps): Promise<WipeOutcome> {
  let identity: DeviceIdentity | null
  try {
    identity = await deps.loadIdentity()
  } catch {
    return 'none'
  }
  if (!identity || typeof identity.requestId !== 'number' || typeof identity.keyFingerprint !== 'string') {
    return 'none'
  }
  let challenge: LoginChallengeResponse
  try {
    challenge = await deps.fetchChallenge(identity.requestId, identity.keyFingerprint)
  } catch {
    // Offline, an older server, a refusal: nothing was ordered that this device can know about.
    return 'none'
  }
  return handleChallengeWipe(identity.requestId, challenge, deps)
}

/**
 * What the server says about this device while a session is open: `revoked` — enrolment is
 * enforced and the device is revoked with no wipe order — on top of the wipe outcomes.
 */
export type DeviceStatusOutcome = WipeOutcome | 'revoked'

/**
 * The signed-in half of {@link checkForWipeOrder}: asked on a timer while a session is open
 * (`useDeviceStatusWatch`), because a revoke does not always end this device's session on the
 * server. A session opened while enrolment was off is not tied to the device, so the revoke never
 * answers it with 401 and the login page — where the order is otherwise found — is never reached
 * until the token expires.
 *
 * A wipe order is carried out exactly as at the login page. A plain revoke is reported as `revoked`
 * **only when enrolment is enforced**: with it off, the server answers `{enforced: false}` and says
 * nothing about the device, because a revoke then stops no login — signing the operator out would
 * only send them back in.
 */
export async function checkDeviceStatus(deps: DeviceWipeDeps = defaultDeviceWipeDeps): Promise<DeviceStatusOutcome> {
  let identity: DeviceIdentity | null
  try {
    identity = await deps.loadIdentity()
  } catch {
    return 'none'
  }
  if (!identity || typeof identity.requestId !== 'number' || typeof identity.keyFingerprint !== 'string') {
    return 'none'
  }
  let challenge: LoginChallengeResponse
  try {
    challenge = await deps.fetchChallenge(identity.requestId, identity.keyFingerprint)
  } catch {
    return 'none'
  }
  const wipe = await handleChallengeWipe(identity.requestId, challenge, deps)
  if (wipe !== 'none') return wipe
  if (challenge?.enforced === true && challenge.deviceStatus === 'REVOKED') return 'revoked'
  return 'none'
}

/** For a caller that already holds a challenge answer (the login): carries out any order in it. */
export async function handleChallengeWipe(
  deviceId: number,
  challenge: LoginChallengeResponse | null,
  deps: DeviceWipeDeps = defaultDeviceWipeDeps
): Promise<WipeOutcome> {
  const wipeOrderedAt = wipeOrderOf(challenge)
  if (wipeOrderedAt == null) return 'none'
  return beginDeviceWipe({ deviceId, wipeOrderedAt }, deps)
}

// =============================================================================================
// Carrying it out — before the database opens
// =============================================================================================

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** Removes every key in a storage area except the wipe marker itself. */
function clearStorageExceptMarker(storage: Storage | null): void {
  if (!storage) return
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key != null && key !== WIPE_MARKER_KEY) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    /* an unreadable storage area holds nothing this app can reach either */
  }
}

/** @returns the server address carried across, or throws when the database would not go. */
async function runDeletion(marker: WipeMarker, deps: DeviceWipeDeps): Promise<string | undefined> {
  // The key first: once it is aside, this device is unenrolled whatever happens next, and a
  // second run (after a crash) finds nothing live and leaves the set-aside key alone.
  try {
    await deps.retireIdentity()
  } catch (err) {
    console.warn('[wipe] could not set the device key aside', err)
  }
  let serverUrl = marker.serverUrl
  if (serverUrl === undefined) {
    serverUrl = await deps.readServerUrl().catch(() => undefined)
  }
  await withTimeout(deps.deleteMainDatabase(), DELETE_TIMEOUT_MS)
  clearStorageExceptMarker(deps.local())
  try {
    deps.session()?.clear()
  } catch {
    /* nothing to do */
  }
  return serverUrl
}

/**
 * Finishes a wipe the marker says is under way. **Called from `main.tsx` before the database is
 * opened** — see the file comment for why nothing else may run first.
 *
 * @returns `none` when there was nothing to do; `wiped` when the data is gone (the caller opens a
 *          fresh database and gives it the server address back); `blocked` when the database could
 *          not be deleted — another open copy of the app is holding it — in which case the caller
 *          must not open the app, and the next start tries again.
 */
export async function resumeDeviceWipe(deps: DeviceWipeDeps = defaultDeviceWipeDeps): Promise<'none' | 'wiped' | 'blocked'> {
  const marker = readWipeMarker(deps)
  if (!marker || marker.stage !== 'wiping') return 'none'

  let serverUrl: string | undefined
  try {
    serverUrl = await runDeletion(marker, deps)
  } catch (err) {
    console.error('[wipe] the local database could not be deleted', err)
    return 'blocked'
  }

  writeMarker({ ...marker, stage: 'confirming', wipedAt: deps.now(), serverUrl }, deps)
  try {
    deps.session()?.setItem(WIPED_NOTICE_KEY, '1')
  } catch {
    /* the notice is a courtesy */
  }
  return 'wiped'
}

/**
 * Gives the fresh database the server address the wiped one held, once. A no-op without a pending
 * confirmation or without an address.
 */
export async function restoreServerUrlAfterWipe(
  save: (serverUrl: string) => Promise<void>,
  deps: Pick<DeviceWipeDeps, 'local'> = defaultDeviceWipeDeps
): Promise<void> {
  const marker = readWipeMarker(deps)
  if (!marker || marker.stage !== 'confirming' || !marker.serverUrl) return
  await save(marker.serverUrl)
  const { serverUrl: _carried, ...rest } = marker
  writeMarker(rest as WipeMarker, deps)
}

// =============================================================================================
// Confirming it
// =============================================================================================

let confirmation: Promise<'none' | 'confirmed' | 'retry'> | null = null

/**
 * Sends the signed confirmation of a carried-out wipe. One at a time; safe to call repeatedly.
 *
 * Let go — the key discarded, the marker cleared — when the server records it, and also when it
 * refuses it for good (a 4xx: the order was withdrawn or the device is unknown to it): there is
 * nothing more this device could ever prove. Kept for the next try on a network failure, a 5xx, a
 * 408 or a 429.
 */
export function confirmPendingWipe(deps: DeviceWipeDeps = defaultDeviceWipeDeps): Promise<'none' | 'confirmed' | 'retry'> {
  if (!confirmation) {
    confirmation = sendConfirmation(deps).finally(() => {
      confirmation = null
    })
  }
  return confirmation
}

function isFinalRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429
}

async function sendConfirmation(deps: DeviceWipeDeps): Promise<'none' | 'confirmed' | 'retry'> {
  const marker = readWipeMarker(deps)
  if (!marker || marker.stage !== 'confirming') return 'none'

  const key = await deps.loadRetiredIdentity().catch(() => null)
  if (!key || key.requestId !== marker.deviceId) {
    // Nothing left that could sign for this device.
    clearMarker(deps)
    return 'none'
  }

  try {
    const signature = await deps.sign(key, wipeMessage(marker.deviceId, marker.wipeOrderedAt))
    await deps.confirm(marker.deviceId, marker.wipeOrderedAt, signature)
  } catch (err) {
    if (!isFinalRefusal(err)) return 'retry'
    console.warn('[wipe] the server will not accept this confirmation; letting it go', err)
  }
  await deps.discardRetiredIdentity().catch(() => undefined)
  clearMarker(deps)
  return 'confirmed'
}

/** Whether this start followed a wipe — read once by the login page, which then clears it. */
export function takeWipedNotice(deps: Pick<DeviceWipeDeps, 'session'> = defaultDeviceWipeDeps): boolean {
  try {
    const session = deps.session()
    if (session?.getItem(WIPED_NOTICE_KEY) !== '1') return false
    session.removeItem(WIPED_NOTICE_KEY)
    return true
  } catch {
    return false
  }
}

/** Tests only. */
export function resetWipeConfirmationForTests(): void {
  confirmation = null
}
