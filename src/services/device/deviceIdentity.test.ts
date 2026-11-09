import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEVICE_IDENTITY_DB_NAME,
  createIdentity,
  discardIdentity,
  enrollMessage,
  ensureIdentity,
  loadIdentity,
  loginMessage,
  normalizeEnrollmentCode,
  saveEnrollmentState,
  signMessage
} from './deviceIdentity'

/** The main database's name — `src/services/storage/db.ts`. */
const MAIN_DB_NAME = 'offline-pwa-db'

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0))
}

async function verify(spkiBase64: string, message: string, signatureBase64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'spki',
    fromBase64(spkiBase64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64(signatureBase64),
    new TextEncoder().encode(message)
  )
}

/**
 * The device's key, and the one property everything else depends on: it cannot be copied off the
 * device, and nothing else in the app can delete it.
 */
describe('device identity', () => {
  afterEach(async () => {
    await discardIdentity()
  })

  it('creates a key whose private half can never be exported', async () => {
    const identity = await createIdentity()

    expect(identity.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('pkcs8', identity.privateKey)).rejects.toBeTruthy()
    // A P-256 SPKI is 91 bytes — what the server parses and fingerprints.
    expect(fromBase64(identity.publicKey).length).toBe(91)
    expect(identity.status).toBe('new')
  })

  it('stays non-extractable after a round trip through storage, and still signs', async () => {
    await createIdentity()
    const stored = await loadIdentity()

    expect(stored?.privateKey.extractable).toBe(false)
    const signature = await signMessage(stored!, 'mfdcs-login\nn\nu')
    // 64 bytes: P1363 (r ‖ s), the format the server verifies with SHA256withECDSAinP1363Format.
    expect(fromBase64(signature).length).toBe(64)
    expect(await verify(stored!.publicKey, 'mfdcs-login\nn\nu', signature)).toBe(true)
    expect(await verify(stored!.publicKey, 'mfdcs-login\nn\nother', signature)).toBe(false)
  })

  it('survives the main database being deleted and recreated', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. openDatabase() deletes `offline-pwa-db` on a
    // VersionError whenever no unsynced work is in it, because everything else there is
    // reference data the next sync refetches. The device key is the one thing no sync can bring
    // back — losing it means an approver has to enrol the tablet again.
    expect(DEVICE_IDENTITY_DB_NAME).not.toBe(MAIN_DB_NAME)

    const before = await createIdentity('tablet 7')
    await saveEnrollmentState({ status: 'approved', requestId: 42, keyFingerprint: 'f'.repeat(64) })

    const main = new Dexie(MAIN_DB_NAME)
    main.version(1).stores({ syncMeta: 'key' })
    await main.open()
    main.close()
    await Dexie.delete(MAIN_DB_NAME)

    const after = await loadIdentity()
    expect(after?.publicKey).toBe(before.publicKey)
    expect(after?.status).toBe('approved')
    expect(after?.requestId).toBe(42)
  })

  it('ensureIdentity keeps an existing key rather than replacing it', async () => {
    const first = await ensureIdentity()
    const second = await ensureIdentity()

    expect(second.publicKey).toBe(first.publicKey)
  })

  it('records what the server said, and forgets only on request', async () => {
    await createIdentity()
    await saveEnrollmentState({ status: 'pending', requestId: 7, keyFingerprint: 'abc', label: 'x' })

    const saved = await loadIdentity()
    expect(saved).toMatchObject({ status: 'pending', requestId: 7, keyFingerprint: 'abc', label: 'x' })

    await discardIdentity()
    expect(await loadIdentity()).toBeNull()
    // Saving with nothing to save onto is a no-op, never an implicit new key.
    expect(await saveEnrollmentState({ status: 'approved' })).toBeNull()
  })
})

describe('what gets signed', () => {
  it('matches the server byte for byte', () => {
    // The same literals DeviceKeysTest.java asserts on the server side. If either side changes
    // the layout, one of the two tests fails.
    expect(loginMessage('NONCE-abc_123', 'ali.rezaei')).toBe('mfdcs-login\nNONCE-abc_123\nali.rezaei')
    expect(enrollMessage(42, '12345678')).toBe('mfdcs-enroll\n42\n12345678')
    expect(loginMessage('N2', 'علی')).toBe('mfdcs-login\nN2\nعلی')
  })

  it('normalises a code exactly as the server does', () => {
    expect(normalizeEnrollmentCode('۱۲۳۴۵۶۷۸')).toBe('12345678')
    expect(normalizeEnrollmentCode('١٢٣٤٥٦٧٨')).toBe('12345678')
    expect(normalizeEnrollmentCode('1234 5678')).toBe('12345678')
    expect(normalizeEnrollmentCode(' 1234-5678 ')).toBe('12345678')
    expect(normalizeEnrollmentCode('۱۲۳۴‌۵۶۷۸')).toBe('12345678')
    // Anything else stays, so it cannot match — never quietly dropped.
    expect(normalizeEnrollmentCode('1234a5678')).toBe('1234a5678')
  })
})
