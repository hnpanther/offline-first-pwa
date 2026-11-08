/**
 * Reading a QR code with the device's camera.
 *
 * <h2>Two decoders, and why both are here</h2>
 *
 * `BarcodeDetector` is a platform API that decodes in native code. Where it exists it is the
 * right answer by a wide margin: on a tablet holding a live camera stream, decode speed is the
 * difference between a scan that lands and one the operator gives up on.
 *
 * **It does not exist everywhere, and that was measured rather than assumed.** A current
 * Chromium browser on Windows reports `window.BarcodeDetector === undefined`: the Shape
 * Detection API ships on Android and macOS, not on every platform Chromium runs on. Betting the
 * whole feature on it would mean QR silently not working on whatever the plant actually buys,
 * discovered by an operator standing in front of a sticker.
 *
 * So `jsqr` is the fallback — no dependencies of its own, and **loaded only when the platform
 * API is missing**. It is a dynamic import, which the build confirms: it lands in its own chunk
 * of **130 KB raw / 47 KB gzipped**, so a device that has `BarcodeDetector` never downloads or
 * parses a byte of it. A device that needs it still has it offline, because workbox precaches
 * every emitted chunk and this one is among the 34 entries.
 *
 * This reverses an earlier decision in this file, and the reason is worth keeping: the argument
 * for "no library" was correct about cost and wrong about availability.
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
  /** A decoder is available but no camera was found. */
  | 'noCamera'
  /** No camera API at all — a desktop browser with the permission blocked, or an odd WebView. */
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
  // The decoder is no longer the thing that can be missing — `jsqr` ships with the app. What
  // can be missing is the camera, which is why this now asks about that and nothing else.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'noDecoder'
  if (!navigator.mediaDevices.getUserMedia) return 'noCamera'
  return 'available'
}

/** Reads one video frame and returns the QR payload in it, or null. */
type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>

/**
 * The decoder this device will use, chosen once per scan session.
 *
 * <p>Native first, always. `jsqr` is imported <b>dynamically and only on the fallback path</b>,
 * so a tablet with the platform API never downloads or parses it — and a tablet without one
 * still has it offline, because the service worker precaches every built chunk.
 */
async function frameDecoder(): Promise<FrameDecoder> {
  const Detector = barcodeDetector()
  if (Detector) {
    const detector = new Detector({ formats: ['qr_code'] })
    return async video => {
      const codes = await detector.detect(video)
      return codes.map(c => (c.rawValue ?? '').trim()).find(v => v.length > 0) ?? null
    }
  }

  const { default: jsQR } = await import('jsqr')
  // One canvas for the whole session. Allocating per frame would churn a buffer the size of the
  // video sixty times a second, which on a field tablet is felt as the camera stuttering.
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('بوم تصویر در دسترس نیست؛ خواندن QR ممکن نشد.')
  }

  return async video => {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.drawImage(video, 0, 0, width, height)
    // `dontInvert`: a printed label is dark-on-light. Asking the decoder to also try the
    // inverted reading doubles the work of every frame for a case this plant does not have.
    const found = jsQR(context.getImageData(0, 0, width, height).data, width, height, {
      inversionAttempts: 'dontInvert'
    })
    const value = (found?.data ?? '').trim()
    return value.length > 0 ? value : null
  }
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

  const decodeFrame = await frameDecoder()

  const result = new Promise<string>((resolve, reject) => {
    const tick = async () => {
      if (stopped) {
        reject(new Error('اسکن متوقف شد.'))
        return
      }
      if (video.readyState >= 2) {
        try {
          const value = await decodeFrame(video)
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
