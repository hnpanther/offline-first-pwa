import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/services/api/client'
import type { LoginRequest, LoginResponse } from '@/types/auth'
import type { EnrollmentStateResponse, LoginChallengeResponse } from '@/types/device'
import {
  DeviceGateError,
  completeEnrollment,
  gateForError,
  gateOf,
  loginWithDevice,
  pendingRequestNumber,
  routeFromChallenge,
  startEnrollment,
  type DeviceAuthDeps
} from './deviceAuth'
import {
  createIdentity,
  discardIdentity,
  enrollMessage,
  loadIdentity,
  loginMessage,
  saveEnrollmentState
} from './deviceIdentity'

const RESPONSE: LoginResponse = {
  username: 'op',
  fullName: 'Operator',
  roles: [],
  permissions: [],
  accessToken: 't',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 60_000
} as unknown as LoginResponse

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0))
}

async function verifies(spki: string, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'spki',
    fromBase64(spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64(signature),
    new TextEncoder().encode(message)
  )
}

function deviceError(status: number, code: string, message = 'refused'): ApiError {
  return new ApiError(status, message, { code, message })
}

function deps(overrides: Partial<DeviceAuthDeps> = {}): DeviceAuthDeps & {
  login: ReturnType<typeof vi.fn>
  fetchLoginChallenge: ReturnType<typeof vi.fn>
} {
  return {
    fetchLoginChallenge: vi.fn<[number, string], Promise<LoginChallengeResponse>>(),
    login: vi.fn<[LoginRequest], Promise<LoginResponse>>().mockResolvedValue(RESPONSE),
    requestDeviceEnrollment: vi.fn(),
    confirmDeviceEnrollment: vi.fn(),
    ...overrides
  } as never
}

async function approvedIdentity(requestId = 9, fingerprint = 'f'.repeat(64)) {
  const identity = await createIdentity()
  await saveEnrollmentState({ status: 'approved', requestId, keyFingerprint: fingerprint })
  return identity
}

afterEach(async () => {
  await discardIdentity()
})

// =============================================================================================

describe('pure decisions', () => {
  it('routes a challenge answer', () => {
    expect(routeFromChallenge(null)).toBe('plain')
    expect(routeFromChallenge({ enforced: false })).toBe('plain')
    expect(routeFromChallenge({ enforced: true, deviceStatus: 'APPROVED', nonce: 'n' })).toBe('sign')
    expect(routeFromChallenge({ enforced: true, deviceStatus: 'PENDING' })).toBe('pending')
    expect(routeFromChallenge({ enforced: true, deviceStatus: 'REVOKED' })).toBe('revoked')
    expect(routeFromChallenge({ enforced: true, deviceStatus: 'UNKNOWN' })).toBe('unknown')
  })

  it('maps device error codes to gates, and nothing else', () => {
    expect(gateForError('ENROLLMENT_REQUIRED')).toBe('enrollment-required')
    expect(gateForError('DEVICE_NOT_APPROVED')).toBe('pending')
    expect(gateForError('DEVICE_REVOKED')).toBe('revoked')
    expect(gateForError('DEVICE_UNKNOWN')).toBe('unknown')
    expect(gateForError('CODE_INVALID')).toBeNull()
    expect(gateForError(null)).toBeNull()
    // An ordinary wrong-password 401 is not a device gate.
    expect(gateOf(new ApiError(401, 'رمز اشتباه', { message: 'رمز اشتباه' }))).toBeNull()
  })
})

// =============================================================================================

describe('logging in', () => {
  it('a never-enrolled tablet sends the login it always sent, in one request', async () => {
    const d = deps()

    await loginWithDevice('op', 'pw', d)

    expect(d.fetchLoginChallenge).not.toHaveBeenCalled()
    expect(d.login).toHaveBeenCalledTimes(1)
    expect(d.login).toHaveBeenCalledWith({ username: 'op', password: 'pw' })
  })

  it('an enrolled tablet signs a fresh nonce when the server enforces enrolment', async () => {
    const identity = await approvedIdentity(9, 'fp')
    const d = deps({
      fetchLoginChallenge: vi.fn().mockResolvedValue({ enforced: true, deviceStatus: 'APPROVED', nonce: 'N-1' })
    })

    await loginWithDevice('ali', 'pw', d)

    expect(d.fetchLoginChallenge).toHaveBeenCalledWith(9, 'fp')
    const sent = d.login.mock.calls[0][0] as LoginRequest
    expect(sent).toMatchObject({ username: 'ali', password: 'pw', deviceId: 9, nonce: 'N-1' })
    // The real signature, by the real stored key, over the exact message the server rebuilds.
    expect(await verifies(identity.publicKey, loginMessage('N-1', 'ali'), sent.signature!)).toBe(true)
  })

  it('an enrolled tablet logs in plainly when enrolment is off on this server', async () => {
    await approvedIdentity()
    const d = deps({ fetchLoginChallenge: vi.fn().mockResolvedValue({ enforced: false }) })

    await loginWithDevice('op', 'pw', d)

    expect(d.login).toHaveBeenCalledWith({ username: 'op', password: 'pw' })
  })

  it('an enrolled tablet logs in plainly against an older server with no challenge endpoint', async () => {
    await approvedIdentity()
    const d = deps({ fetchLoginChallenge: vi.fn().mockRejectedValue(new ApiError(404, 'not found')) })

    await loginWithDevice('op', 'pw', d)

    expect(d.login).toHaveBeenCalledWith({ username: 'op', password: 'pw' })
  })

  it.each([
    ['PENDING', 'pending'],
    ['REVOKED', 'revoked'],
    ['UNKNOWN', 'unknown']
  ] as const)('a device the server reports %s is stopped before the password is sent', async (status, gate) => {
    await approvedIdentity()
    const d = deps({ fetchLoginChallenge: vi.fn().mockResolvedValue({ enforced: true, deviceStatus: status }) })

    const failure = await loginWithDevice('op', 'pw', d).catch(e => e)

    expect(failure).toBeInstanceOf(DeviceGateError)
    expect(gateOf(failure)).toBe(gate)
    expect(d.login).not.toHaveBeenCalled()
  })

  it('an unenrolled tablet refused by an enforcing server surfaces the enrolment gate', async () => {
    const d = deps({ login: vi.fn().mockRejectedValue(deviceError(403, 'ENROLLMENT_REQUIRED')) })

    const failure = await loginWithDevice('op', 'pw', d).catch(e => e)

    expect(gateOf(failure)).toBe('enrollment-required')
  })

  it('retries once with a proof when the switch was turned on between challenge and login', async () => {
    await approvedIdentity(9, 'fp')
    const challenges = vi
      .fn()
      .mockResolvedValueOnce({ enforced: false })
      .mockResolvedValueOnce({ enforced: true, deviceStatus: 'APPROVED', nonce: 'N-2' })
    const login = vi
      .fn()
      .mockRejectedValueOnce(deviceError(403, 'ENROLLMENT_REQUIRED'))
      .mockResolvedValueOnce(RESPONSE)
    const d = deps({ fetchLoginChallenge: challenges, login })

    await loginWithDevice('op', 'pw', d)

    expect(login).toHaveBeenCalledTimes(2)
    expect(login.mock.calls[1][0]).toMatchObject({ deviceId: 9, nonce: 'N-2' })
  })

  it('does not retry an ordinary refusal', async () => {
    await approvedIdentity()
    const login = vi.fn().mockRejectedValue(new ApiError(401, 'رمز اشتباه', { message: 'رمز اشتباه' }))
    const d = deps({ fetchLoginChallenge: vi.fn().mockResolvedValue({ enforced: false }), login })

    await expect(loginWithDevice('op', 'pw', d)).rejects.toBeInstanceOf(ApiError)
    expect(login).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================================

describe('enrolling', () => {
  it('sends this device’s public key and keeps the request it is given', async () => {
    const request = vi.fn().mockResolvedValue({
      requestId: 31,
      status: 'PENDING',
      keyFingerprint: 'server-fp',
      expiresAt: 123
    } satisfies EnrollmentStateResponse)
    const d = deps({ requestDeviceEnrollment: request })

    const view = await startEnrollment(' تبلت ۷ ', d)

    const identity = await loadIdentity()
    expect(request).toHaveBeenCalledWith(identity!.publicKey, 'تبلت ۷')
    expect(view).toEqual({ requestId: 31, status: 'PENDING', expiresAt: 123 })
    expect(identity).toMatchObject({ status: 'pending', requestId: 31, keyFingerprint: 'server-fp', label: 'تبلت ۷' })
    expect(await pendingRequestNumber()).toBe(31)
  })

  it('replaces a key the server has revoked, and asks again with the new one', async () => {
    const old = await createIdentity()
    const request = vi
      .fn()
      .mockRejectedValueOnce(deviceError(403, 'DEVICE_REVOKED'))
      .mockResolvedValueOnce({ requestId: 40, status: 'PENDING', keyFingerprint: 'new-fp' })
    const d = deps({ requestDeviceEnrollment: request })

    await startEnrollment(undefined, d)

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0]).not.toBe(old.publicKey)
    expect((await loadIdentity())?.requestId).toBe(40)
  })

  it('does not throw away a key over any other refusal', async () => {
    const old = await createIdentity()
    const d = deps({ requestDeviceEnrollment: vi.fn().mockRejectedValue(deviceError(429, 'TOO_MANY_PENDING')) })

    await expect(startEnrollment(undefined, d)).rejects.toBeInstanceOf(ApiError)
    expect((await loadIdentity())?.publicKey).toBe(old.publicKey)
  })

  it('signs the normalised code together with its request, and records approval', async () => {
    const identity = await createIdentity()
    await saveEnrollmentState({ status: 'pending', requestId: 31, keyFingerprint: 'fp' })
    const confirm = vi.fn().mockResolvedValue({ requestId: 31, status: 'APPROVED', keyFingerprint: 'fp' })
    const d = deps({ confirmDeviceEnrollment: confirm })

    const view = await completeEnrollment('۱۲۳۴ ۵۶۷۸', d)

    const [requestId, code, signature] = confirm.mock.calls[0]
    expect(requestId).toBe(31)
    expect(code).toBe('12345678')
    expect(await verifies(identity.publicKey, enrollMessage(31, '12345678'), signature)).toBe(true)
    expect(view.status).toBe('APPROVED')
    expect((await loadIdentity())?.status).toBe('approved')
    expect(await pendingRequestNumber()).toBeNull()
  })

  it('a wrong code leaves the device pending and passes the server’s answer through', async () => {
    await createIdentity()
    await saveEnrollmentState({ status: 'pending', requestId: 31, keyFingerprint: 'fp' })
    const refusal = new ApiError(400, 'کد ثبت درست نیست.', { code: 'CODE_INVALID', message: 'x', attemptsLeft: 3 })
    const d = deps({ confirmDeviceEnrollment: vi.fn().mockRejectedValue(refusal) })

    await expect(completeEnrollment('00000000', d)).rejects.toBe(refusal)
    expect((await loadIdentity())?.status).toBe('pending')
  })

  it('cannot confirm before a request exists', async () => {
    await expect(completeEnrollment('12345678', deps())).rejects.toThrow()
  })
})
