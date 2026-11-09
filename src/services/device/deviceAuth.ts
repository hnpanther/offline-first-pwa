import { ApiError } from '@/services/api/client'
import {
  confirmDeviceEnrollment,
  fetchLoginChallenge,
  login as apiLogin,
  requestDeviceEnrollment
} from '@/services/api'
import type { LoginRequest, LoginResponse } from '@/types/auth'
import {
  deviceErrorCode,
  type DeviceErrorCode,
  type EnrollmentStateResponse,
  type LoginChallengeResponse
} from '@/types/device'
import {
  createIdentity,
  discardIdentity,
  enrollMessage,
  ensureIdentity,
  loadIdentity,
  loginMessage,
  normalizeEnrollmentCode,
  saveEnrollmentState,
  signMessage,
  type DeviceIdentity
} from './deviceIdentity'

/**
 * Logging in from an enrolled device, and enrolling one.
 *
 * <h2>What changes for a server that does not enrol devices</h2>
 *
 * Nothing. A tablet that has never been enrolled sends the login it always sent, in one request.
 * A tablet that *has* been enrolled first asks `/api/auth/challenge`; a server with enrolment off
 * answers `{enforced: false}`, an older server answers 404, and in both cases the login goes out
 * exactly as before. The challenge is the only extra request, and only an enrolled tablet makes
 * it.
 *
 * <h2>What a gate is</h2>
 *
 * Something between this device and a login that a password cannot fix: the device is not
 * enrolled, is waiting for its code, was revoked, or is not recognised. The login screen shows
 * the enrolment card for every one of them.
 */

export type DeviceGate = 'enrollment-required' | 'pending' | 'revoked' | 'unknown'

/** Raised when the device, not the password, is what stops a login. */
export class DeviceGateError extends Error {
  constructor(
    public readonly gate: DeviceGate,
    message: string
  ) {
    super(message)
    this.name = 'DeviceGateError'
  }
}

const GATE_MESSAGES: Record<DeviceGate, string> = {
  'enrollment-required': 'این دستگاه برای ورود ثبت نشده است. ابتدا دستگاه را ثبت کنید.',
  pending: 'این دستگاه هنوز تأیید نشده است. کد ثبت را از مدیر سامانه بگیرید.',
  revoked: 'مجوز این دستگاه لغو شده است. برای استفادهٔ دوباره، دستگاه باید از نو ثبت شود.',
  unknown: 'این دستگاه در سرور شناخته نمی‌شود. دستگاه را دوباره ثبت کنید.'
}

/** The calls this module makes, injectable so every branch can be tested without a server. */
export interface DeviceAuthDeps {
  fetchLoginChallenge: (deviceId: number, keyFingerprint: string) => Promise<LoginChallengeResponse>
  login: (request: LoginRequest) => Promise<LoginResponse>
  requestDeviceEnrollment: (publicKey: string, label: string | undefined) => Promise<EnrollmentStateResponse>
  confirmDeviceEnrollment: (
    requestId: number,
    enrollmentCode: string,
    signature: string
  ) => Promise<EnrollmentStateResponse>
}

const defaultDeps: DeviceAuthDeps = {
  fetchLoginChallenge: (deviceId, keyFingerprint) => fetchLoginChallenge(deviceId, keyFingerprint),
  login: request => apiLogin(request),
  requestDeviceEnrollment: (publicKey, label) => requestDeviceEnrollment(publicKey, label),
  confirmDeviceEnrollment: (requestId, code, signature) =>
    confirmDeviceEnrollment(requestId, code, signature)
}

// =============================================================================================
// Pure decisions
// =============================================================================================

/**
 * How to log in, given the challenge answer. `null` means the challenge could not be asked at all
 * — an older server without the endpoint, or a network failure the login itself will report.
 */
export function routeFromChallenge(
  challenge: LoginChallengeResponse | null
): 'plain' | 'sign' | Exclude<DeviceGate, 'enrollment-required'> {
  if (!challenge || !challenge.enforced) return 'plain'
  switch (challenge.deviceStatus) {
    case 'APPROVED':
      return challenge.nonce ? 'sign' : 'plain'
    case 'PENDING':
      return 'pending'
    case 'REVOKED':
      return 'revoked'
    default:
      return 'unknown'
  }
}

/** The gate a server device error stands for, or null when the error is about something else. */
export function gateForError(code: DeviceErrorCode | null): DeviceGate | null {
  switch (code) {
    case 'ENROLLMENT_REQUIRED':
      return 'enrollment-required'
    case 'DEVICE_NOT_APPROVED':
      return 'pending'
    case 'DEVICE_REVOKED':
      return 'revoked'
    case 'DEVICE_UNKNOWN':
      return 'unknown'
    default:
      return null
  }
}

/** The gate behind a caught error — a `DeviceGateError` or a server device error — or null. */
export function gateOf(err: unknown): DeviceGate | null {
  if (err instanceof DeviceGateError) return err.gate
  if (err instanceof ApiError) return gateForError(deviceErrorCode(err.body))
  return null
}

function isApproved(identity: DeviceIdentity | null): identity is DeviceIdentity & {
  requestId: number
  keyFingerprint: string
} {
  return (
    identity !== null &&
    identity.status === 'approved' &&
    typeof identity.requestId === 'number' &&
    typeof identity.keyFingerprint === 'string'
  )
}

// =============================================================================================
// Login
// =============================================================================================

type Proof =
  | { kind: 'none' }
  | { kind: 'signed'; fields: Pick<LoginRequest, 'deviceId' | 'nonce' | 'signature'> }

async function prepareProof(username: string, deps: DeviceAuthDeps): Promise<Proof> {
  const identity = await loadIdentity()
  if (!isApproved(identity)) return { kind: 'none' }

  let challenge: LoginChallengeResponse | null
  try {
    challenge = await deps.fetchLoginChallenge(identity.requestId, identity.keyFingerprint)
  } catch {
    // An older server has no such endpoint; a network failure will be reported, accurately, by
    // the login that follows. Either way: log in as before.
    challenge = null
  }

  const route = routeFromChallenge(challenge)
  if (route === 'plain') return { kind: 'none' }
  if (route === 'sign' && challenge?.nonce) {
    const signature = await signMessage(identity, loginMessage(challenge.nonce, username))
    return {
      kind: 'signed',
      fields: { deviceId: identity.requestId, nonce: challenge.nonce, signature }
    }
  }
  throw new DeviceGateError(route as DeviceGate, GATE_MESSAGES[route as DeviceGate])
}

/**
 * Logs in, attaching a device proof when — and only when — the server asks for one.
 *
 * <p>One retry, for one case: an enrolled tablet asked the challenge, was told enrolment is off,
 * and by the time its plain login arrived an administrator had switched it on. Refusing that
 * login would show an enrolled device the enrolment card. Asking again costs one request in a
 * situation that happens at most once per switch.
 *
 * @throws DeviceGateError when the device itself stops the login before it is sent
 * @throws ApiError for anything the server refused — a device error carries its code in `body`
 */
export async function loginWithDevice(
  username: string,
  password: string,
  deps: DeviceAuthDeps = defaultDeps
): Promise<LoginResponse> {
  const proof = await prepareProof(username, deps)
  try {
    return await deps.login({ username, password, ...(proof.kind === 'signed' ? proof.fields : {}) })
  } catch (err) {
    if (proof.kind === 'none' && gateOf(err) === 'enrollment-required' && isApproved(await loadIdentity())) {
      const again = await prepareProof(username, deps)
      if (again.kind === 'signed') {
        return deps.login({ username, password, ...again.fields })
      }
    }
    throw err
  }
}

// =============================================================================================
// Enrolment
// =============================================================================================

/** What the enrolment card shows. */
export interface EnrollmentView {
  requestId: number
  status: 'PENDING' | 'APPROVED'
  expiresAt?: number
}

/**
 * Asks to be enrolled — or resumes an earlier request, since the server answers the same key
 * with the same request number.
 *
 * <p>A key the server has revoked can never be used again; the server says so, and this replaces
 * it with a new key and asks once more. The new request still needs an approver's code, so
 * nothing about a revocation is undone by it.
 */
export async function startEnrollment(
  label: string | undefined,
  deps: DeviceAuthDeps = defaultDeps
): Promise<EnrollmentView> {
  const trimmed = label?.trim() || undefined
  let identity = await ensureIdentity(trimmed)
  let state: EnrollmentStateResponse
  try {
    state = await deps.requestDeviceEnrollment(identity.publicKey, trimmed ?? identity.label)
  } catch (err) {
    if (!(err instanceof ApiError && deviceErrorCode(err.body) === 'DEVICE_REVOKED')) throw err
    await discardIdentity()
    identity = await createIdentity(trimmed ?? identity.label)
    state = await deps.requestDeviceEnrollment(identity.publicKey, trimmed ?? identity.label)
  }
  await saveEnrollmentState({
    status: state.status === 'APPROVED' ? 'approved' : 'pending',
    requestId: state.requestId,
    keyFingerprint: state.keyFingerprint,
    label: trimmed ?? identity.label
  })
  return { requestId: state.requestId, status: state.status, expiresAt: state.expiresAt }
}

/**
 * Completes enrolment with the code an approver gave. The code is normalised (Persian digits,
 * grouping) and signed together with the request number, so it is accepted from this device
 * and from no other.
 */
export async function completeEnrollment(
  rawCode: string,
  deps: DeviceAuthDeps = defaultDeps
): Promise<EnrollmentView> {
  const identity = await loadIdentity()
  if (!identity || typeof identity.requestId !== 'number') {
    throw new Error('ابتدا درخواست ثبت این دستگاه را بفرستید.')
  }
  const code = normalizeEnrollmentCode(rawCode)
  const signature = await signMessage(identity, enrollMessage(identity.requestId, code))
  const state = await deps.confirmDeviceEnrollment(identity.requestId, code, signature)
  await saveEnrollmentState({
    status: state.status === 'APPROVED' ? 'approved' : 'pending',
    requestId: state.requestId,
    keyFingerprint: state.keyFingerprint
  })
  return { requestId: state.requestId, status: state.status, expiresAt: state.expiresAt }
}

/**
 * Throws away this device's key and starts over — for a key the server revoked or no longer
 * knows. Only ever called on an explicit tap, never automatically.
 */
export async function restartEnrollment(
  label: string | undefined,
  deps: DeviceAuthDeps = defaultDeps
): Promise<EnrollmentView> {
  await discardIdentity()
  return startEnrollment(label, deps)
}

/** The pending request this device already holds, if any — so the card can resume it. */
export async function pendingRequestNumber(): Promise<number | null> {
  const identity = await loadIdentity()
  return identity?.status === 'pending' && typeof identity.requestId === 'number'
    ? identity.requestId
    : null
}
