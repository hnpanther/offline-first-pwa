/**
 * The `signature` field's form value on the device (backend roadmap §32).
 *
 * The stored shape is the server's:
 *
 *   { type: 'signature', ids: ['<uuid>'], signedByUserId, signedAt, answersHash, hashAlgo }
 *
 * but this device writes only **`type`, `ids` and `signedAt`**. Who signed comes from the session
 * the round is synced under, and the hash of the answers the signature covers is computed by the
 * server alone — two canonicalisations, one here and one in Java, would drift, and every signature
 * taken offline would then read as stale with nothing to point at. Anything else a device sends
 * is ignored by the server, so a payload cannot claim a signer.
 *
 * The drawing's id sits under `ids`, the key every attachment reader already uses
 * (`attachmentIdsOf`), so blankness, the upload queue and the archive path's «is there work here»
 * need no second case for it.
 */
import { attachmentIdsOf } from '@/services/storage/attachments'

export interface SignatureValue {
  type: 'signature'
  ids: string[]
  /** Device time the drawing was accepted — what the server records when it is plausible. */
  signedAt: number
  /**
   * Device-only fingerprint of what the signature covered when it was drawn here
   * (`utils/signatureVerdict.ts`). The server ignores it, and it disappears when the server's
   * stamped copy replaces this one — after which the server's verdict takes over.
   */
  localFingerprint?: string
  /** The scope the server recorded it under; absent on a drawing still on its way. */
  scope?: string
  // Present on a value that came back from the server; never written here.
  signedByUserId?: number | string
  answersHash?: string
  hashAlgo?: string
}

/** The value a freshly accepted drawing becomes. */
export function buildSignatureValue(
  attachmentId: string,
  signedAt: number,
  localFingerprint?: string
): SignatureValue {
  return {
    type: 'signature',
    ids: [attachmentId],
    signedAt,
    ...(localFingerprint ? { localFingerprint } : {})
  }
}

/** The drawing a value names, or null when the field is unsigned. */
export function signatureIdOf(value: unknown): string | null {
  const ids = attachmentIdsOf(value)
  return ids.length > 0 ? ids[0] : null
}

/** When it was signed, as recorded — the server's stamp once synced, the device's before. */
export function signedAtOf(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const raw = (value as { signedAt?: unknown }).signedAt
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Whether a value came back stamped by the server — signed for the record, not just drawn. */
export function isServerStamped(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as { signedByUserId?: unknown; answersHash?: unknown }
  return v.signedByUserId != null && typeof v.answersHash === 'string'
}
