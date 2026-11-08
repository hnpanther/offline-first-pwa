/**
 * Reading a QR code or a linear barcode with the device's camera.
 *
 * <h2>The bug this file is shaped around</h2>
 *
 * On Android the camera opened, the operator aimed at a sticker, and **nothing ever happened**.
 * Not an error — nothing. The phone's own camera app read the same sticker instantly.
 *
 * Two defects stacked to produce that:
 *
 * 1. `window.BarcodeDetector` being defined was taken as proof that it works. It is not. The
 *    spec is explicit: a browser that cannot detect barcodes still exposes the constructor and
 *    resolves `getSupportedFormats()` with an **empty list**. On Android the detector is backed
 *    by a Play Services module that is downloaded on demand and is simply absent for an app
 *    that has not pulled it in — Chrome has it, a plain WebView host does not. So the detector
 *    was constructed happily and then rejected every single `detect()` call.
 * 2. The frame loop caught **every** error and treated it as "the operator is still aiming".
 *    That is right for one frame and catastrophic for all of them: a permanently broken decoder
 *    became an infinite silent loop, which is exactly "nothing happens".
 *
 * So the rules here are: **prove the decoder works before trusting it**, **fail over to the
 * bundled one when it stops working**, and **never fail silently forever**.
 *
 * <h2>Two decoders, and why both are here</h2>
 *
 * `BarcodeDetector` decodes in native code, and on a tablet holding a live camera stream that
 * speed is the difference between a scan that lands and one the operator gives up on. It is
 * also the **only** one of the two that reads linear barcodes at all.
 *
 * `jsqr` is the fallback: no dependencies, QR only, loaded **only when the platform API cannot
 * be used**. It is a dynamic import, which the build confirms — its own chunk of 130 KB raw /
 * 47 KB gzipped, so a device with a working `BarcodeDetector` never downloads or parses a byte
 * of it, and a device that needs it still has it offline because workbox precaches every
 * emitted chunk.
 *
 * <h2>Why the session reports on itself</h2>
 *
 * {@link QrScanSession.stats} exists because "nothing happens" was impossible to tell apart
 * from "the camera never produced a frame" and from "the decoder is refusing". The dialog shows
 * which decoder ran, how many frames it has looked at, and the last error — so the next report
 * from a plant arrives with its own diagnosis instead of needing one.
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

/** What the caller wants to read. A field's `BARCODE` source means linear, not QR. */
export type CodeFamily = 'qr' | 'barcode'

/**
 * Which decoder actually ran. Reported, never guessed.
 *
 * There is no "none" member on purpose: a session that could not choose a decoder throws during
 * setup rather than existing in a state that has to be reported, so every value here names a
 * decoder that really did run.
 */
export type DecoderName = 'native' | 'jsqr' | 'native-app'

export type QrScanSupport =
  /** A camera and a decoder are both available. */
  | 'available'
  /** A decoder is available but no camera was found. */
  | 'noCamera'
  /** No camera API at all — a desktop browser with the permission blocked, or an odd WebView. */
  | 'noDecoder'

/**
 * The platform names for each family.
 *
 * Linear formats are listed explicitly rather than asking for everything: a detector told to
 * look for twelve symbologies spends every frame looking for eleven that are not on the label.
 */
const NATIVE_FORMATS: Record<CodeFamily, string[]> = {
  qr: ['qr_code'],
  barcode: [
    'code_128',
    'code_39',
    'code_93',
    'codabar',
    'ean_13',
    'ean_8',
    'itf',
    'upc_a',
    'upc_e'
  ]
}

/**
 * Consecutive decoder throws tolerated before the scan gives up and says so.
 *
 * Not one: a frame can fail while the camera reconfigures, and ending the session on that would
 * make the scanner flaky. Not unbounded: that was the bug.
 */
const HARD_FAILURE_LIMIT = 12

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
 * Whether this device can open a camera at all.
 *
 * Deliberately does **not** request camera permission and does **not** probe the decoder: it is
 * called while rendering the fill page to decide whether to offer the button, a permission
 * prompt on page load is the fastest way to teach an operator to press «deny», and the decoder
 * probe is asynchronous. Which decoder will serve is settled when the scan actually starts —
 * and if none can, the dialog says so in words.
 */
export function qrScanSupport(): QrScanSupport {
  if (nativeQrAvailable()) return 'available'
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'noDecoder'
  if (!navigator.mediaDevices.getUserMedia) return 'noCamera'
  return 'available'
}

/** Reads one video frame and returns the payload in it, or null when there is none yet. */
type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>

interface ActiveDecoder {
  name: DecoderName
  decode: FrameDecoder
  /** Families this decoder can actually read, after the platform was asked. */
  families: CodeFamily[]
}

function firstPayload(codes: DetectedBarcode[]): string | null {
  return codes.map(c => (c.rawValue ?? '').trim()).find(v => v.length > 0) ?? null
}

/**
 * Whether the platform decoder can serve this request, and with which formats — the decision
 * the Android bug got wrong.
 *
 * <p>Kept pure and exported so it can be tested without a camera, a DOM or a device, because
 * the input that broke it is a single value nobody looked at: `supported` being an **empty
 * array**. Per the spec that is how a browser says "I cannot detect barcodes" while still
 * exposing the constructor, and treating it as "fine" is what produced a detector that
 * rejected every frame in silence.
 *
 * @param supported what `BarcodeDetector.getSupportedFormats()` resolved with. Null or
 *        undefined for a platform that has no such method at all.
 * @returns the formats to construct the detector with and the families it will then cover, or
 *        null to mean "do not use the platform decoder". Never a partial yes.
 */
export function usableNativeFormats(
  families: CodeFamily[],
  supported: readonly string[] | null | undefined
): { families: CodeFamily[]; formats: string[] } | null {
  if (!Array.isArray(supported) || supported.length === 0) return null

  const covered = families.filter(f => NATIVE_FORMATS[f].some(n => supported.includes(n)))
  if (covered.length === 0) return null

  // Only formats the platform actually listed. Constructing a detector with a format it does
  // not know is how a working decoder gets thrown away for no reason.
  const formats = covered.flatMap(f => NATIVE_FORMATS[f].filter(n => supported.includes(n)))
  return { families: covered, formats }
}

/** What to do when a decoder throws on a frame. */
export type DecodeErrorAction =
  /** Ordinary: the operator is still aiming, or one frame arrived malformed. */
  | 'retry'
  /** The platform decoder is not working. Switch to the bundled one and carry on. */
  | 'failover'
  /** It has failed too many times in a row. Tell the operator instead of spinning. */
  | 'giveUp'

/**
 * The decision the old loop never made.
 *
 * <p>It caught every error and always retried, which is correct for a single frame and is a
 * silent infinite loop for a decoder that is broken. Three outcomes instead of one, and the
 * difference between them is the whole fix.
 *
 * @param consecutiveErrors failures **since the last frame the decoder handled**, counting the
 *        one being decided now. A decode that merely found nothing resets this, because the
 *        decoder worked.
 */
export function decideOnDecodeError(state: {
  decoder: DecoderName
  fallbackTried: boolean
  wantsQr: boolean
  consecutiveErrors: number
}): DecodeErrorAction {
  // One switch, and only away from the platform decoder: the bundled one is the last resort,
  // so there is nowhere to fail over to from it. It needs QR in the request, since that is the
  // only thing it reads.
  if (state.decoder === 'native' && !state.fallbackTried && state.wantsQr) {
    return 'failover'
  }
  return state.consecutiveErrors >= HARD_FAILURE_LIMIT ? 'giveUp' : 'retry'
}

/**
 * The platform decoder, **only if it proves it works**.
 *
 * <p>Two gates, and both are needed. `getSupportedFormats()` is the spec's own answer to "is
 * detection available" — an empty list means no. A trial `detect()` catches the case that gate
 * misses: a detector can list formats and still reject on first real use, because the Android
 * backing module is fetched on demand. Answering that here means falling back; answering it in
 * the frame loop meant swallowing it forever.
 *
 * @returns the decoder, or null to say "use the fallback" — never a half-working one.
 */
async function nativeDecoder(families: CodeFamily[]): Promise<ActiveDecoder | null> {
  const Detector = barcodeDetector()
  if (!Detector || typeof Detector.getSupportedFormats !== 'function') return null

  try {
    const usable = usableNativeFormats(families, await Detector.getSupportedFormats())
    if (!usable) return null

    const detector = new Detector({ formats: usable.formats })

    // The trial. A 2x2 canvas holds no code, so an empty result is success: what is being
    // checked is that the call completes at all.
    const probe = document.createElement('canvas')
    probe.width = 2
    probe.height = 2
    await detector.detect(probe)

    return {
      name: 'native',
      families: usable.families,
      decode: async video => {
        if (!video.videoWidth || !video.videoHeight) return null
        return firstPayload(await detector.detect(video))
      }
    }
  } catch {
    // Includes a constructor that throws, which some WebView hosts do when the Play Services
    // binding is missing. The fallback is why that is survivable rather than fatal.
    return null
  }
}

/** The bundled decoder. QR only — there is no linear symbology in `jsqr`. */
async function jsqrDecoder(): Promise<ActiveDecoder> {
  const { default: jsQR } = await import('jsqr')
  // One canvas for the whole session. Allocating per frame would churn a buffer the size of the
  // video sixty times a second, which on a field tablet is felt as the camera stuttering.
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('بوم تصویر در دسترس نیست؛ خواندن QR ممکن نشد.')
  }

  return {
    name: 'jsqr',
    families: ['qr'],
    decode: async video => {
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
}

/**
 * The decoder this session will use.
 *
 * <p>Native first, because it is faster and because it is the only one that reads a linear
 * barcode. When it cannot be used and the caller wanted *only* a linear barcode, this refuses
 * out loud: opening a camera that physically cannot read the label the operator is holding is
 * the silent failure all over again, one layer up.
 */
async function chooseDecoder(families: CodeFamily[]): Promise<ActiveDecoder> {
  const native = await nativeDecoder(families)
  if (native) return native
  if (!families.includes('qr')) {
    throw new Error(
      'این دستگاه بارکد خطی را نمی‌خواند. مقدار را دستی وارد کنید یا از QR استفاده کنید.'
    )
  }
  return jsqrDecoder()
}

export interface QrScanStats {
  /** Which decoder is running. Always a real one — see {@link DecoderName}. */
  decoder: DecoderName
  /** Frames handed to the decoder. Still zero means the camera, not the decoder. */
  framesTried: number
  /** The last decoder error, already readable. Null while nothing has gone wrong. */
  lastError: string | null
  /** Families the chosen decoder can read — narrower than asked for on some devices. */
  families: CodeFamily[]
}

export interface QrScanSession {
  /** The video element the caller must place in the DOM for the operator to aim with. */
  video: HTMLVideoElement
  /** Resolves with the decoded payload, or rejects if the session is stopped or fails. */
  result: Promise<string>
  /** Stops the camera and releases the track. Safe to call more than once. */
  stop: () => void
  /** Live diagnostics. Read whenever — the dialog polls this while the camera is open. */
  stats: () => QrScanStats
}

export interface QrScanOptions {
  /** What to look for. QR only by default, which is what an asset sticker carries. */
  families?: CodeFamily[]
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name ? `${err.name}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * Opens the camera and resolves with the first payload it reads.
 *
 * <p>The caller owns the `video` element and must stop the session when the operator closes the
 * scanner — **including on unmount**. A camera track that outlives its page keeps the sensor
 * powered and the indicator light on, which on a tablet that stays on one screen for a whole
 * shift is both a battery cost and something an operator reasonably reads as the app watching
 * them.
 */
export async function startQrScan(options: QrScanOptions = {}): Promise<QrScanSession> {
  const families: CodeFamily[] = options.families?.length ? options.families : ['qr']

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
      stop: () => {},
      stats: () => ({ decoder: 'native-app', framesTried: 0, lastError: null, families })
    }
  }

  // `environment` is the rear camera on a tablet. Not `exact`, so a device with only a front
  // camera still scans rather than throwing OverconstrainedError at the operator.
  //
  // The resolution is asked for, not accepted: the default on many Android devices is 640x480,
  // and a dense label at the distance someone holds a tablet does not survive that. `ideal`
  // rather than `exact`, so a camera that cannot manage it still opens.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  })

  // Continuous autofocus where the device exposes it. A fixed-focus frame of a small label is
  // blurry at arm's length, and a blurry frame decodes as nothing at all — which looks exactly
  // like a broken scanner, and was one of the things "nothing happens" could have meant.
  const [track] = stream.getVideoTracks()
  try {
    await track?.applyConstraints({
      advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet]
    })
  } catch {
    // Not every camera exposes focusMode. The lens then does whatever it does by default.
  }

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
    stream.getTracks().forEach(t => t.stop())
    video.srcObject = null
  }

  let active: ActiveDecoder
  try {
    active = await chooseDecoder(families)
  } catch (err) {
    // No decoder at all: release the camera rather than leaving the sensor powered behind a
    // dialog that is about to show an error.
    stop()
    throw err
  }

  let framesTried = 0
  let lastError: string | null = null
  let consecutiveErrors = 0
  let fallbackTried = active.name !== 'native'

  const stats = (): QrScanStats => ({
    decoder: active.name,
    framesTried,
    lastError,
    families: active.families
  })

  const result = new Promise<string>((resolve, reject) => {
    const tick = async () => {
      if (stopped) {
        reject(new Error('اسکن متوقف شد.'))
        return
      }
      if (video.readyState >= 2) {
        framesTried += 1
        try {
          const value = await active.decode(video)
          // The decoder ran. Whether or not a code was in shot, it is working.
          consecutiveErrors = 0
          if (value) {
            stop()
            resolve(value)
            return
          }
        } catch (err) {
          lastError = describe(err)
          consecutiveErrors += 1

          const action = decideOnDecodeError({
            decoder: active.name,
            fallbackTried,
            wantsQr: families.includes('qr'),
            consecutiveErrors
          })

          if (action === 'failover') {
            // The platform decoder passed its probe and then failed on a real frame. One
            // switch to the bundled decoder, mid-session, rather than spinning: this is the
            // Android case the whole file is built around.
            fallbackTried = true
            try {
              active = await jsqrDecoder()
              consecutiveErrors = 0
            } catch (fallbackErr) {
              // Nothing left to try. The next error decides, now that failover is spent.
              lastError = describe(fallbackErr)
            }
          } else if (action === 'giveUp') {
            stop()
            reject(new Error(`خواندن کد روی این دستگاه ممکن نشد (${lastError}).`))
            return
          }
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

  return { video, result, stop, stats }
}

/**
 * What this device can decode, for the admin device check.
 *
 * <p>Opens no camera: it probes the decoders only. This is the page an admin opens when an
 * operator says scanning does not work, so it answers what was previously unanswerable —
 * whether this tablet can read a linear barcode at all, and which decoder a QR would use.
 */
export interface DecoderReport {
  decoder: DecoderName
  families: CodeFamily[]
  /** What the platform API listed, or null when it is absent. `[]` is its "unavailable". */
  nativeSupportedFormats: string[] | null
}

export async function decoderReport(): Promise<DecoderReport> {
  if (nativeQrAvailable()) {
    return { decoder: 'native-app', families: ['qr', 'barcode'], nativeSupportedFormats: null }
  }

  const Detector = barcodeDetector()
  let nativeSupportedFormats: string[] | null = null
  if (Detector && typeof Detector.getSupportedFormats === 'function') {
    try {
      nativeSupportedFormats = await Detector.getSupportedFormats()
    } catch {
      nativeSupportedFormats = []
    }
  }

  const native = await nativeDecoder(['qr', 'barcode'])
  if (native) {
    return { decoder: native.name, families: native.families, nativeSupportedFormats }
  }
  return { decoder: 'jsqr', families: ['qr'], nativeSupportedFormats }
}
