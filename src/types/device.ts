/**
 * Device enrolment — the wire shapes.
 *
 * Mirrors the backend's `dto/device/DeviceDtos.java`. A field renamed on one side and not the
 * other is a tablet that cannot log in, so change both in the same commit.
 */

/** Where a device stands with the server. `UNKNOWN` is the server not recognising the key at all. */
export type DeviceStatus = 'PENDING' | 'APPROVED' | 'REVOKED' | 'UNKNOWN'

/** The answer to an enrolment request or confirmation. */
export interface EnrollmentStateResponse {
  /** The number the operator reads to the approver; once approved, the device id. */
  requestId: number
  status: 'PENDING' | 'APPROVED'
  /** The server's own fingerprint of the key — echoed back at login, never recomputed here. */
  keyFingerprint: string
  /** Until when a pending request can still be completed. Absent once approved. */
  expiresAt?: number
}

/** The answer to `/api/auth/challenge`. */
export interface LoginChallengeResponse {
  /** False: device enrolment is off on this server — log in exactly as before. */
  enforced: boolean
  deviceStatus?: DeviceStatus
  /** Present only for an approved device. Single-use, short-lived. */
  nonce?: string
  expiresAt?: number
}

/**
 * Every machine code the server can answer a device step with. The `message` beside it is the
 * Persian sentence to show; the code is what the app branches on.
 */
export type DeviceErrorCode =
  | 'ENROLLMENT_DISABLED'
  | 'ENROLLMENT_REQUIRED'
  | 'INVALID_KEY'
  | 'TOO_MANY_PENDING'
  | 'REQUEST_CONFLICT'
  | 'REQUEST_UNKNOWN'
  | 'REQUEST_EXPIRED'
  | 'CODE_NOT_ISSUED'
  | 'CODE_EXPIRED'
  | 'CODE_INVALID'
  | 'CODE_LOCKED'
  | 'SIGNATURE_INVALID'
  | 'CHALLENGE_INVALID'
  | 'DEVICE_UNKNOWN'
  | 'DEVICE_NOT_APPROVED'
  | 'DEVICE_REVOKED'

export interface DeviceErrorBody {
  code: DeviceErrorCode
  message: string
  attemptsLeft?: number
}

/** Reads a device error code out of an error body, or null for any other kind of error. */
export function deviceErrorCode(body: unknown): DeviceErrorCode | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' && DEVICE_ERROR_CODES.has(code as DeviceErrorCode)
    ? (code as DeviceErrorCode)
    : null
}

const DEVICE_ERROR_CODES = new Set<DeviceErrorCode>([
  'ENROLLMENT_DISABLED',
  'ENROLLMENT_REQUIRED',
  'INVALID_KEY',
  'TOO_MANY_PENDING',
  'REQUEST_CONFLICT',
  'REQUEST_UNKNOWN',
  'REQUEST_EXPIRED',
  'CODE_NOT_ISSUED',
  'CODE_EXPIRED',
  'CODE_INVALID',
  'CODE_LOCKED',
  'SIGNATURE_INVALID',
  'CHALLENGE_INVALID',
  'DEVICE_UNKNOWN',
  'DEVICE_NOT_APPROVED',
  'DEVICE_REVOKED'
])
