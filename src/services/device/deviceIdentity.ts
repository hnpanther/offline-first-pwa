import Dexie, { type Table } from 'dexie'

/**
 * This device's identity for enrolment: a key it generated and can never export.
 *
 * <h2>Why a key, and why it cannot be copied</h2>
 *
 * The key pair is created by WebCrypto with `extractable: false`. The private half can sign but
 * cannot be read out — not by another page, not by this app's own JavaScript, not by a support
 * person with the tablet in hand and devtools open. A random id kept in storage would be a
 * string anyone could copy to another phone; this cannot be.
 *
 * <h2>Why it lives in its own database</h2>
 *
 * **Not in `offline-pwa-db`, deliberately.** `openDatabase()` deletes and recreates that database
 * on a `VersionError` whenever it holds no unsynced work, on the stated assumption that
 * everything else in it is reference data the next sync refetches. A device key is the one thing
 * the server can never send back: losing it means an approver has to enrol the tablet again.
 * Kept there, it would be deleted on exactly the tablets that had just synced cleanly. So it gets
 * a database of its own, with one store and a schema that is never meant to change, and nothing
 * else in the app opens, clears or versions it — not logout, not switching user on a shared
 * tablet, not the main schema's upgrades. `deviceIdentity.test.ts` pins that.
 *
 * <h2>What it does not protect against</h2>
 *
 * Clearing the app's data, reinstalling, or a factory reset removes it, and that is correct: a
 * wiped tablet is a new device and has to be enrolled again. The same act also removes unsynced
 * readings, which is the larger loss and the one the rest of the app is built around.
 */

const IDENTITY_DB_NAME = 'mfdcs-device-identity'
const RECORD_ID = 'device'

/** Where this device's enrolment stands, as far as this device knows. */
export type LocalEnrollmentStatus = 'new' | 'pending' | 'approved'

export interface DeviceIdentity {
  id: typeof RECORD_ID
  /** Non-extractable. Signs; can never be exported. */
  privateKey: CryptoKey
  /** The public half, SPKI DER, base64 — what the server stores. */
  publicKey: string
  status: LocalEnrollmentStatus
  /** The request number, and once approved the device id, the server assigned. */
  requestId?: number
  /** The server's fingerprint of this key, echoed back at login. */
  keyFingerprint?: string
  /** An operator-typed name, kept so a renewed request carries it again. */
  label?: string
  createdAt: number
}

class DeviceIdentityDatabase extends Dexie {
  identity!: Table<DeviceIdentity, string>

  constructor() {
    super(IDENTITY_DB_NAME)
    // One version, forever. A change here would need a migration of the one record that must
    // never be lost; add a second store instead.
    this.version(1).stores({ identity: 'id' })
  }
}

const identityDb = new DeviceIdentityDatabase()

/** The database name, exported for the test that proves the main database cannot reach it. */
export const DEVICE_IDENTITY_DB_NAME = IDENTITY_DB_NAME

/**
 * Whether this context can create and use a device key at all.
 *
 * WebCrypto exists only in a secure context. Production is HTTPS and the packaged app is
 * `https://localhost`, so both have it; a developer on `http://<lan-ip>:5173` does not, and
 * enrolment must say why rather than fail obscurely.
 */
export function deviceCryptoAvailable(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined'
}

export async function loadIdentity(): Promise<DeviceIdentity | null> {
  return (await identityDb.identity.get(RECORD_ID)) ?? null
}

/** Creates a fresh key pair, replacing any previous identity. */
export async function createIdentity(label?: string): Promise<DeviceIdentity> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // the private key can never be exported — the whole point
    ['sign', 'verify']
  )) as CryptoKeyPair
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
  const identity: DeviceIdentity = {
    id: RECORD_ID,
    privateKey: pair.privateKey,
    publicKey: toBase64(new Uint8Array(spki)),
    status: 'new',
    label: label?.trim() || undefined,
    createdAt: Date.now()
  }
  await identityDb.identity.put(identity)
  return identity
}

/** The existing identity, or a new one if this device has none yet. */
export async function ensureIdentity(label?: string): Promise<DeviceIdentity> {
  return (await loadIdentity()) ?? createIdentity(label)
}

/** Records what the server said about this key. */
export async function saveEnrollmentState(
  update: Pick<DeviceIdentity, 'status'> & Partial<Pick<DeviceIdentity, 'requestId' | 'keyFingerprint' | 'label'>>
): Promise<DeviceIdentity | null> {
  const current = await loadIdentity()
  if (!current) return null
  const next: DeviceIdentity = { ...current, ...update }
  await identityDb.identity.put(next)
  return next
}

/**
 * Forgets this key. Only for a key the server has revoked or no longer knows — at that point it
 * can never be used again, and the next request must come from a new one.
 */
export async function discardIdentity(): Promise<void> {
  await identityDb.identity.delete(RECORD_ID)
}

/** Signs a UTF-8 message; the signature is IEEE P1363 (`r ‖ s`), base64. */
export async function signMessage(identity: DeviceIdentity, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(message)
  )
  return toBase64(new Uint8Array(signature))
}

// ---------------------------------------------------------------------------------------------
// What gets signed. Must match `DeviceKeys.java` byte for byte; each side has a test pinning it.
// ---------------------------------------------------------------------------------------------

export function loginMessage(nonce: string, username: string): string {
  return `mfdcs-login\n${nonce}\n${username}`
}

export function enrollMessage(requestId: number, normalizedCode: string): string {
  return `mfdcs-enroll\n${requestId}\n${normalizedCode}`
}

/**
 * The code as typed, reduced to ASCII digits — the same rule as the server's
 * `DeviceKeys.normalizeCode`.
 *
 * A Persian keyboard types «۱۲۳۴» and an Arabic one «١٢٣٤»; spaces and dashes are the grouping
 * the panel shows. Anything else is kept, so a stray character makes the code wrong rather than
 * silently becoming a different code.
 */
export function normalizeEnrollmentCode(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (code >= 0x06f0 && code <= 0x06f9) {
      out += String.fromCharCode(48 + code - 0x06f0)
    } else if (code >= 0x0660 && code <= 0x0669) {
      out += String.fromCharCode(48 + code - 0x0660)
    } else if (
      ch === ' ' ||
      ch === '-' ||
      ch === '‐' ||
      ch === '‑' ||
      ch === ' ' ||
      ch === '‌' ||
      ch === '\t'
    ) {
      // grouping and stray whitespace, including the zero-width non-joiner of a Persian keyboard
    } else {
      out += ch
    }
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
