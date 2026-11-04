/**
 * Reading a QR code with the device's camera.
 *
 * <h2>Why there is no QR library in this bundle</h2>
 *
 * Decoding a QR code is `BarcodeDetector`, a platform API present in Chrome on Android since 83
 * and therefore in the Android System WebView the packaged app runs in. Shipping a JavaScript
 * decoder beside it would add a dependency, a build step and ~40 KB to every tablet in order to
 * re-implement something the platform already does in native code — and do it slower, which on a
 * field tablet holding a camera stream is the difference between a scan that lands and one the
 * operator gives up on.
 *
 * What that trade costs is honesty about the gap: a device without the API gets **no QR
 * scanning at all**, so this module reports that as a first-class state rather than failing at
 * the moment the operator presses the button. The fallback is the one that already exists —
 * typing the id, under the same rules as the NFC fault path.
 *
 * <h2>The native door, left open</h2>
 *
 * {@link nativeQrAvailable} mirrors `nativeNfc`: if a future build registers a Capacitor plugin
 * named `Qr`, this module prefers it and nothing on the page changes. That is how NFC reached
 * the packaged app, and a QR plugin (ML Kit or ZXing) is the same shape of work.
 *
 * <h2>What a scan yields</h2>
 *
 * **The raw payload, trimmed, and nothing else.** A QR code on an asset carries the value
 * `asset_entries.nfc_tag_id` holds — the identifier the tag already carries. No parsing, no URL
 * unwrapping, no prefix stripping: inventing a transformation here would mean a sticker printed
 * from the panel and a sticker printed from a label machine resolving differently, and the one
 * that failed would be the one in the plant.
 */

import { nativePlugin } from '@/services/device/nativeApp'

export type QrScanSupport =
  /** A camera and a decoder are both available. */
  | 'available'
  /** The decoder exists but no camera was granted or found. */
  | 'noCamera'
  /** This browser has no barcode decoder — see the module note. */
  | 'noDecoder'

interface DetectedBarcode {
  rawValue?: string
  format?: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

interface NativeQrPlugin {
  scan: () => Promise<{ value?: string | null } | null>
}

function barcodeDetector(): BarcodeDetectorConstructor | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
}

/** The packaged app's own reader, when a build registers one. Absent in every browser. */
export function nativeQrAvailable(): boolean {
  const plugin = nativePlugin('Qr') as NativeQrPlugin | undefined
  return typeof plugin?.scan === 'function'
}

/**
 * Whether this device can scan a QR code at all.
 *
 * Deliberately does **not** request camera permission: it is called while rendering the fill
 * page to decide whether to offer the button, and a permission prompt on page load is the
 * fastest way to teach an operator to press «deny».
 */
export function qrScanSupport(): QrScanSupport {
  if (nativeQrAvailable()) return 'available'
  if (!barcodeDetector()) return 'noDecoder'
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'noCamera'
  }
  return 'available'
}

export interface QrScanSession {
  /** The video element the caller must place in the DOM for the operator to aim with. */
  video: HTMLVideoElement
  /** Resolves with the decoded payload, or rejects if the session is stopped or fails. */
  result: Promise<string>
  /** Stops the camera and releases the track. Safe to call more than once. */
  stop: () => void
}

/**
 * Opens the camera and resolves with the first QR payload it reads.
 *
 * <p>The caller owns the `video` element and must stop the session when the operator closes the
 * scanner — **including on unmount**. A camera track that outlives its page keeps the sensor
 * powered and the indicator light on, which on a tablet that stays on one screen for a whole
 * shift is both a battery cost and something an operator reasonably reads as the app watching
 * them.
 */
export async function startQrScan(): Promise<QrScanSession> {
  const native = nativePlugin('Qr') as NativeQrPlugin | undefined
  if (typeof native?.scan === 'function') {
    // The native reader draws its own camera UI, so there is no video element to place. The
    // empty one keeps the caller's shape identical either way.
    const video = document.createElement('video')
    return {
      video,
      result: native.scan().then(res => {
        const value = (res?.value ?? '').trim()
        if (!value) throw new Error('هیچ کد QR خوانده نشد.')
        return value
      }),
      stop: () => {}
    }
  }

  const Detector = barcodeDetector()
  if (!Detector) {
    throw new Error('این دستگاه از خواندن QR Code پشتیبانی نمی‌کند.')
  }

  // `environment` is the rear camera on a tablet. Not `exact`, so a device with only a front
  // camera still scans rather than throwing OverconstrainedError at the operator.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }
  })

  const video = document.createElement('video')
  video.setAttribute('playsinline', 'true')
  video.muted = true
  video.srcObject = stream

  let stopped = false
  let frame = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    if (frame) cancelAnimationFrame(frame)
    stream.getTracks().forEach(track => track.stop())
    video.srcObject = null
  }

  const detector = new Detector({ formats: ['qr_code'] })

  const result = new Promise<string>((resolve, reject) => {
    const tick = async () => {
      if (stopped) {
        reject(new Error('اسکن متوقف شد.'))
        return
      }
      if (video.readyState >= 2) {
        try {
          const codes = await detector.detect(video)
          const value = codes.map(c => (c.rawValue ?? '').trim()).find(v => v.length > 0)
          if (value) {
            stop()
            resolve(value)
            return
          }
        } catch {
          // A single failed frame is ordinary — the operator is still aiming. Only a stopped
          // session ends this loop.
        }
      }
      frame = requestAnimationFrame(() => void tick())
    }

    video
      .play()
      .then(() => void tick())
      .catch(err => {
        stop()
        reject(err instanceof Error ? err : new Error('دوربین باز نشد.'))
      })
  })

  return { video, result, stop }
}
