import type { NFCTagData } from '@/types'
import { nativePlugin } from '@/services/device/nativeApp'

/**
 * Tag reading through the Android app's own NFC reader, for builds where Web NFC does not exist.
 *
 * <h2>Why this is needed at all</h2>
 *
 * The browser path uses **Web NFC** (`window.NDEFReader`), which is a Chrome API. Android's
 * WebView does not implement it, so inside the packaged app `NDEFReader` is simply absent and
 * scanning would be unavailable — not denied, not broken, just missing. The plugin puts
 * `NfcAdapter` behind the same door.
 *
 * <h2>The bridge carries Web-NFC-shaped payloads, not raw NDEF</h2>
 *
 * Each record crosses as **bytes**, base64'd, with its type — and those bytes are what Web NFC
 * would have handed over, not what is physically on the tag. Web NFC normalises two well-known
 * record types before giving them to the page, so the native side must do the same or the two
 * routes read the same tag differently:
 *
 * <ul>
 *   <li><b>text</b> — the NDEF payload begins with a status byte whose low bits give the length
 *       of a language code, then that code, then the text. Web NFC strips both. Left in, the
 *       shared decoder sees a *longer* string and prefers it, so `ASSET-42` reads as
 *       `enASSET-42`.</li>
 *   <li><b>uri</b> — the first byte indexes a prefix table (`0x04` = `https://`). Web NFC
 *       expands it. Left in, the id carries a control character where the scheme belongs.</li>
 * </ul>
 *
 * Everything else passes through untouched.
 *
 * <h2>Why only those two, and nothing more</h2>
 *
 * Those two rules are fixed by the NFC Forum spec and cannot drift. Everything *else* about
 * reading a tag — mislabelled records, media types that lie, choosing which record holds the
 * asset id — is heuristics learned from tags in this plant, and lives once in
 * `decodeRecordData`. Duplicating that in Java would mean a tag reading differently depending on
 * whether the operator was in Chrome or in the app: the worst way for this to fail, and the
 * hardest to notice.
 */

/** What the Java side emits, one per NDEF record. */
export interface NativeNfcRecord {
  /** Web NFC's vocabulary — `text`, `url`, `mime`, `absolute-url`, `empty`, `unknown`, or an
   *  external type — so the shared decoder needs no separate mapping for the native path. */
  recordType: string
  mediaType?: string
  /**
   * The record's payload, base64 — already normalised the way Web NFC normalises it (see the
   * module note). Empty or absent for a record that carries none.
   */
  payload?: string
}

export interface NativeNfcTag {
  serialNumber?: string
  records?: NativeNfcRecord[]
}

interface NfcPluginApi {
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>
  startScan(): Promise<void>
  stopScan(): Promise<void>
  addListener(
    event: 'nfcTag',
    handler: (tag: NativeNfcTag) => void
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> }
  addListener(
    event: 'nfcError',
    handler: (payload: { message?: string }) => void
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> }
}

function plugin(): NfcPluginApi | undefined {
  return nativePlugin<NfcPluginApi>('Nfc')
}

/** Whether this build can read tags natively at all. Cheap and synchronous, for feature checks. */
export function hasNativeNfcPlugin(): boolean {
  return plugin() != null
}

/**
 * Whether the device has NFC hardware and it is switched on.
 *
 * <p>The two are reported separately because they need different words to the operator: hardware
 * that is missing is permanent, and hardware that is off is one tap away in Settings. Anything
 * unexpected from the bridge is reported as "no hardware" rather than thrown — a diagnostic
 * question must not take the fill page down with it.
 */
export async function nativeNfcStatus(): Promise<{ available: boolean; enabled: boolean }> {
  const api = plugin()
  if (!api) return { available: false, enabled: false }
  try {
    const status = await api.isAvailable()
    return { available: status?.available === true, enabled: status?.enabled === true }
  } catch {
    return { available: false, enabled: false }
  }
}

/** base64 → bytes, so the shared decoder sees exactly what Web NFC would have handed it. */
export function decodeBase64(payload: string | undefined): Uint8Array {
  if (!payload) return new Uint8Array(0)
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Starts the native reader, calling back for every tag until the returned function is called.
 *
 * @param decode turns the raw records into the app's `NFCTagData`. Injected rather than imported
 *        so this module stays a transport and the one decoder lives in `services/nfc`.
 */
export async function startNativeNfcScan(
  decode: (tag: NativeNfcTag) => NFCTagData,
  onTag: (tag: NFCTagData) => void,
  onError: (message: string) => void
): Promise<() => void> {
  const api = plugin()
  if (!api) {
    onError('NFC در این دستگاه پشتیبانی نمی‌شود.')
    return () => {}
  }

  const tagHandle = await api.addListener('nfcTag', raw => {
    try {
      onTag(decode(raw))
    } catch {
      // A tag whose payload will not decode is a bad read, not a broken app: say so and let
      // the operator try again rather than tearing the listener down.
      onError('خطا در خواندن تگ NFC')
    }
  })
  const errorHandle = await api.addListener('nfcError', payload => {
    onError(payload?.message || 'خطا در خواندن تگ NFC')
  })

  try {
    await api.startScan()
  } catch (err) {
    await tagHandle?.remove?.()
    await errorHandle?.remove?.()
    onError(err instanceof Error ? err.message : 'خطا در راه‌اندازی NFC')
    return () => {}
  }

  // Listeners are removed as well as the scan stopped. Leaving them attached across a page
  // change would deliver a tag to a callback whose screen is gone.
  return () => {
    void api.stopScan().catch(() => {})
    void tagHandle?.remove?.()
    void errorHandle?.remove?.()
  }
}
