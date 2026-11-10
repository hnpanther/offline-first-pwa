/**
 * Reading a QR code or a linear barcode with the device's camera.
 *
 * <h2>The bug this file is shaped around</h2>
 *
 * On Android the camera opened, the operator aimed at a sticker, and **nothing ever happened**.
 * Not an error — nothing. The phone's own camera app read the same sticker instantly.
 *
 * The cause was the decoder, and specifically where it came from. `window.BarcodeDetector` on
 * Android is backed by a Google Play Services module that is **downloaded on demand**. These
 * handhelds have no network, ever, so the module was never fetched — and the way that surfaces is
 * the worst possible one: the constructor exists, `getSupportedFormats()` answers with a real
 * list, `detect()` resolves without throwing, and returns an empty array for every frame for ever.
 * Measured on the device: 434 frames, no errors, no reads.
 *
 * Three rounds of defence were built against that — proving the detector with a trial `detect()`,
 * failing over on an error, then a rescue that re-read the frame off a canvas and through a second
 * bundled decoder. None of them could work, because **nothing ever reported a failure**. A
 * decoder that answers «no code here» 434 times is indistinguishable from an operator with bad aim.
 *
 * So the decoder is no longer something the platform provides. ZXing (`zxing-wasm`, the C++
 * `zxing-cpp` reader compiled to WebAssembly) is compiled into the app, and «offline» stops being
 * a condition scanning can fail under. One decoder, one code path, in the browser and in the APK.
 *
 * <h2>What replacing `BarcodeDetector` actually bought</h2>
 *
 * <ul>
 *   <li>**Linear barcodes work at all.** The old fallback was `jsqr`, which reads QR and no linear
 *       symbology whatsoever. So on these devices a field set to `BARCODE` could never be scanned:
 *       the platform decoder was blind and the fallback did not implement the format. ZXing reads
 *       Code 128, Code 39, Code 93, Codabar, EAN-8/13, ITF and UPC-A/E in the same pass.</li>
 *   <li>**No «prove it works» dance, no failover, no rescue.** All of it existed to survive one
 *       decoder's absence, and about 250 lines went with it.</li>
 *   <li>**One behaviour to support.** A fault is now in the app, reproducible at a desk, rather
 *       than a property of which Play Services modules a given tablet happened to pull down.</li>
 * </ul>
 *
 * The cost is a 925 KB WebAssembly file, precached once. On a fleet that downloads the app over
 * plant Wi-Fi once and then never again, that is the cheap half of the trade.
 *
 * <h2>Two passes over a frame, and why the fast one is first</h2>
 *
 * ZXing's defaults optimise for accuracy: rotation, inversion and `tryHarder` all on. That is the
 * right setting for a label the operator is struggling with and the wrong one for the first second,
 * when it just costs frames. So every frame gets a cheap read of exactly the accepted formats, and
 * only after {@link THOROUGH_AFTER_MS} does every third frame get the expensive one. A scan that
 * was going to work is unaffected; a scan that is not working gets more help the longer it runs.
 *
 * <h2>What a scan yields</h2>
 *
 * **The raw payload, trimmed, and nothing else.** A QR code on an asset carries the value
 * `asset_entries.nfc_tag_id` holds — the identifier the tag already carries. No parsing, no URL
 * unwrapping, no prefix stripping: inventing a transformation here would mean a sticker printed
 * from the panel and a sticker printed from a label machine resolving differently, and the one
 * that failed would be the one in the plant. `textMode: 'Plain'` is part of that promise — ZXing's
 * own default is `HRI`, which reformats GS1 content with bracketed application identifiers and
 * would hand back something no tag ever stored.
 */

import { nativePlugin } from '@/services/device/nativeApp'
import type { ScanDecoder } from './zxingModule'
import type { ReadInputBarcodeFormat, ReaderOptions, ReadResult } from 'zxing-wasm/reader'

/**
 * The decoder, reached only through a dynamic import.
 *
 * <p>Type-only imports above, so nothing ZXing ships is linked into this module. That matters
 * because the fill page imports *this* file eagerly — it must, to decide whether to render a scan
 * button — and a static import here would put the Emscripten glue in the main chunk for every
 * page load on every tablet, scanning or not.
 */
function decoderModule() {
  return import('./zxingModule')
}

/** What the caller wants to read. A field's `BARCODE` source means linear, not QR. */
export type CodeFamily = 'qr' | 'barcode'

/**
 * Which decoder ran. Reported, never guessed.
 *
 * Two members, and `'zxing'` is every browser and every APK build. `'native-app'` is reserved for
 * a packaged build that registers its own reader plugin; no build does today, and the branch is
 * kept because the NFC reader uses exactly that shape.
 *
 * `'native'` (the platform `BarcodeDetector`) and `'jsqr'` are gone — see the file header.
 */
export type DecoderName = 'zxing' | 'native-app'

export type QrScanSupport =
  /** A camera and a decoder are both available. */
  | 'available'
  /** A decoder is available but no camera was found. */
  | 'noCamera'
  /** No camera API at all — a desktop browser with the permission blocked, or an odd WebView. */
  | 'noDecoder'

/**
 * The ZXing formats for each family, for the **fast** per-frame pass.
 *
 * Listed explicitly rather than asking for `All`: Data Matrix, Aztec, PDF417 and MaxiCode are not
 * on a plant's labels, and every enabled symbology is work on every frame. The linear set is the
 * one the platform decoder was asked for before, name for name, so no label that used to scan has
 * quietly stopped being looked for.
 */
export const FAST_FORMATS: Record<CodeFamily, ReadInputBarcodeFormat[]> = {
  qr: ['QRCode'],
  barcode: [
    'Code128',
    'Code39',
    'Code93',
    'Codabar',
    'EAN13',
    'EAN8',
    'ITF',
    'UPCA',
    'UPCE'
  ]
}

/**
 * The extra formats the thorough pass adds — the QR variants small nameplates carry.
 *
 * In `zxing-cpp` these are separate bits from `QRCode`, so a Micro QR is simply not looked for
 * unless named. They are not on the fast pass because almost every label in this plant is a
 * standard QR, and a scan that completes in the first second should not pay for the exceptions.
 */
const THOROUGH_EXTRA_FORMATS: Record<CodeFamily, ReadInputBarcodeFormat[]> = {
  qr: ['MicroQRCode', 'RMQRCode'],
  barcode: ['ITF14', 'DataBar', 'DataBarExp']
}

/**
 * Consecutive decoder throws tolerated before the scan gives up and says so.
 *
 * Not one: a frame can fail while the camera reconfigures, and ending the session on that would
 * make the scanner flaky. Not unbounded: that was half of the original bug — a loop that caught
 * every error and always retried is a silent infinite loop for a decoder that is broken.
 */
const HARD_FAILURE_LIMIT = 12

/**
 * How long the cheap read runs alone before the expensive one joins it.
 *
 * A scan that works at all works well inside this, so the common case never pays for rotation,
 * inversion and `tryHarder`. Past it the operator is already struggling, and spending three times
 * as long on every third frame is the right trade.
 */
export const THOROUGH_AFTER_MS = 1500

/**
 * How often a frame is also searched for the kinds the caller does NOT accept — only to say «that
 * was a QR, this field takes a barcode». Every eighth frame is a few times a second: enough to
 * name a wrong code within a moment of it being held up, while the other seven frames run the
 * accepted search alone.
 */
export const WRONG_KIND_PROBE_EVERY = 8

/**
 * Nothing about the probe exists for the first seconds of a scan. Almost every scan that works
 * completes within them, and the probe is built lazily, only for a scan that is already not
 * reading anything.
 */
export const WRONG_KIND_PROBE_AFTER_MS = 3000

interface NativeQrPlugin {
  scan: () => Promise<{ value?: string | null } | null>
}

/** The packaged app's own reader, when a build registers one. Absent in every browser. */
export function nativeQrAvailable(): boolean {
  const plugin = nativePlugin('Qr') as NativeQrPlugin | undefined
  return typeof plugin?.scan === 'function'
}

/**
 * Whether this device can open a camera at all.
 *
 * Deliberately does **not** request camera permission: it is called while rendering the fill page
 * to decide whether to offer the button, and a permission prompt on page load is the fastest way
 * to teach an operator to press «رد».
 *
 * It no longer has to hedge about the decoder either. The decoder ships with the app, so the only
 * open question on any device is the camera — which is the whole point of the change this file
 * records.
 */
export function qrScanSupport(): QrScanSupport {
  if (nativeQrAvailable()) return 'available'
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return 'noDecoder'
  if (!navigator.mediaDevices.getUserMedia) return 'noCamera'
  return 'available'
}

/** A code found in a frame: its payload, which kind of code it was, and whether to take it. */
export interface Detection {
  value: string
  family: CodeFamily
  /**
   * Whether this read may complete the scan. Decided by WHICH pass produced it, never by the
   * format name it reports: the per-frame read is asked for the accepted formats only, so whatever
   * it returns is acceptable by construction. Re-judging its reads by their reported format name
   * once rejected a correct QR on a platform that spelled the format differently. Only the
   * occasional wide probe yields `false`.
   */
  accepted: boolean
}

/**
 * Which kind of code a ZXing result is, from its **symbology** rather than its format.
 *
 * The symbology is the root: `QRCodeModel2`, `MicroQRCode` and `RMQRCode` all report `QRCode`, so
 * one comparison covers every QR variant instead of a list that a new variant falls out of.
 * Anything that is not QR is reported as a linear barcode, which is true of everything this
 * scanner is ever asked for.
 */
export function familyOfFormat(symbology: string | undefined): CodeFamily {
  return symbology === 'QRCode' ? 'qr' : 'barcode'
}

/**
 * The code to act on in one frame: the first of a kind the caller accepts, else the first of any
 * kind (so the dialog can name it), else null.
 *
 * Not simply the first code. A label can carry a QR **and** a linear barcode, and a decoder
 * looking for several symbologies can also report a spurious linear read off printed text; taking
 * whichever came first set the wanted code aside on every frame in which the other one was listed
 * ahead of it — a camera that sees the label and never reads it.
 */
export function pickDetection(
  codes: readonly { text?: string; symbology?: string }[],
  accepted: readonly CodeFamily[]
): Omit<Detection, 'accepted'> | null {
  let other: Omit<Detection, 'accepted'> | null = null
  for (const code of codes) {
    const value = (code.text ?? '').trim()
    if (value.length === 0) continue
    const detection = { value, family: familyOfFormat(code.symbology) }
    if (accepted.includes(detection.family)) return detection
    other ??= detection
  }
  return other
}

/** The first non-empty payload, for a pass whose formats are all acceptable by construction. */
function firstPayload(codes: readonly ReadResult[]): string | null {
  return codes.map(c => (c.text ?? '').trim()).find(v => v.length > 0) ?? null
}

/** What to do when a decode throws on a frame. */
export type DecodeErrorAction =
  /** Ordinary: the operator is still aiming, or one frame arrived malformed. */
  | 'retry'
  /** It has failed too many times in a row. Tell the operator instead of spinning. */
  | 'giveUp'

/**
 * The decision the old loop never made.
 *
 * <p>It caught every error and always retried, which is correct for a single frame and is a
 * silent infinite loop for a decoder that keeps throwing. There is deliberately no third outcome
 * any more: `'failover'` existed to escape the platform decoder, and there is no longer a platform
 * decoder to escape. One decoder that is part of the app either works on this device or is broken
 * for a reason worth reporting.
 *
 * @param consecutiveErrors failures **since the last frame the decoder handled**, counting the
 *        one being decided now. A decode that merely found nothing resets this, because the
 *        decoder worked.
 */
export function decideOnDecodeError(consecutiveErrors: number): DecodeErrorAction {
  return consecutiveErrors >= HARD_FAILURE_LIMIT ? 'giveUp' : 'retry'
}

/**
 * The reader options for one pass.
 *
 * <p>`textMode: 'Plain'` is the load-bearing one: it is the promise that a scan yields the tag's
 * own bytes. ZXing defaults to `'HRI'`, which rewrites GS1 payloads with bracketed application
 * identifiers — a transformation that would make a scanned value stop matching the stored
 * `nfc_tag_id` for exactly the labels that carry structured data.
 *
 * <p>`maxNumberOfSymbols: 1` because a frame's second code is never wanted and finding it costs
 * the rest of the pass. `tryDenoise` is left off: it is marked experimental upstream and is
 * matrix-only, so it would help nothing this scanner is asked for.
 *
 * <p>Exported for `zxingDecode.test.ts`, which decodes real generated symbols with **these**
 * options rather than a copy of them. A test that restated the settings would keep passing while
 * the ones the operator's camera uses drifted.
 */
export function readerOptions(formats: ReadInputBarcodeFormat[], thorough: boolean): ReaderOptions {
  return {
    formats,
    textMode: 'Plain',
    maxNumberOfSymbols: 1,
    // The expensive three. Rotation matters for a linear label held across a portrait tablet;
    // inversion matters for an engraved or etched plate; tryHarder is ZXing's own escalation.
    tryHarder: thorough,
    tryRotate: thorough,
    tryInvert: thorough,
    // Left on in both passes: ZXing's own image pyramid is how a label photographed too close
    // still resolves, and it is cheap next to the options above.
    tryDownscale: true
  }
}

export interface QrScanStats {
  /** Which decoder is running. Always a real one — see {@link DecoderName}. */
  decoder: DecoderName
  /** Frames handed to the decoder. Still zero means the camera, not the decoder. */
  framesTried: number
  /** The last decoder error, already readable. Null while nothing has gone wrong. */
  lastError: string | null
  /** Families the decoder is reading. No longer narrowed by the device — see the file header. */
  families: CodeFamily[]
  /** A further line from the decoder: which pass is running, and the frame size it reads. */
  detail: string | null
  /**
   * The last kind of code seen that this caller does NOT accept — a QR held up to a field that
   * takes only linear barcodes, say. Null until that happens. Reported so the dialog can say so
   * instead of looking like a scanner that never reads anything.
   */
  ignoredFamily: CodeFamily | null
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
        if (!value) throw new Error('هیچ کدی خوانده نشد.')
        return value
      }),
      stop: () => {},
      stats: () => ({
        decoder: 'native-app',
        framesTried: 0,
        lastError: null,
        families,
        ignoredFamily: null,
        detail: null
      })
    }
  }

  // Started here and awaited below, so the chunk and its ~925 KB of WebAssembly are read and
  // instantiated while the camera is still warming up. Sequentially this would add its whole cost
  // to the wait before the operator sees a picture; concurrently it is free, because
  // `getUserMedia` takes longer than it does.
  const decoderReady = decoderModule().then(m => m.loadDecoder())

  // `environment` is the rear camera on a tablet. Not `exact`, so a device with only a front
  // camera still scans rather than throwing OverconstrainedError at the operator.
  //
  // The resolution is asked for, not accepted: the default on many Android devices is 640x480,
  // and a dense label at the distance someone holds a tablet does not survive that. `ideal`
  // rather than `exact`, so a camera that cannot manage it still opens.
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    })
  } catch (err) {
    // The decoder load is already in flight and memoised; nothing to release. Swallowing its
    // rejection keeps an unhandled promise out of the console on a denied camera.
    void decoderReady.catch(() => {})
    throw err
  }

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

  let decoder: ScanDecoder
  try {
    decoder = await decoderReady
  } catch (err) {
    // The decoder could not be loaded — `DecoderUnavailableError`, which already says in Persian
    // that the install is missing a file. Release the camera rather than leaving the sensor
    // powered behind a dialog that is about to show an error.
    stop()
    throw err
  }

  // One canvas for the whole session. Allocating per frame would churn a buffer the size of the
  // video sixty times a second, which on a field tablet is felt as the camera stuttering.
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    stop()
    throw new Error('بوم تصویر در دسترس نیست؛ خواندن کد ممکن نشد.')
  }

  const fastFormats = families.flatMap(f => FAST_FORMATS[f])
  const thoroughFormats = [...fastFormats, ...families.flatMap(f => THOROUGH_EXTRA_FORMATS[f])]
  const otherFamilies = (['qr', 'barcode'] as CodeFamily[]).filter(f => !families.includes(f))
  const otherFormats = otherFamilies.flatMap(f => FAST_FORMATS[f])

  const startedAt = Date.now()
  let framesTried = 0
  let lastError: string | null = null
  let consecutiveErrors = 0
  let ignoredFamily: CodeFamily | null = null
  let thoroughRuns = 0
  let probeRuns = 0
  let frameSize = ''

  const stats = (): QrScanStats => ({
    decoder: 'zxing',
    framesTried,
    lastError,
    families,
    ignoredFamily,
    detail: [
      `ZXing ${decoder.version}`,
      frameSize ? `فریم ${frameSize}` : null,
      thoroughRuns > 0 ? `جست‌وجوی دقیق: ${thoroughRuns} بار` : null,
      probeRuns > 0 ? `جست‌وجوی کد نامرتبط: ${probeRuns} بار` : null
    ]
      .filter(Boolean)
      .join(' — ')
  })

  const result = new Promise<string>((resolve, reject) => {
    const tick = async () => {
      if (stopped) {
        reject(new Error('اسکن متوقف شد.'))
        return
      }
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        framesTried += 1
        try {
          if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
          if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          frameSize = `${canvas.width}×${canvas.height}`
          // Read once and reused by every pass below: the pixels do not change between them, and
          // getImageData on a 1280x720 frame is the single most expensive call in the loop.
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height)

          const elapsed = Date.now() - startedAt
          // After a silent stretch, every third frame gets the expensive read. Not every frame:
          // the cheap pass is what reads an ordinary label, and starving it would make a scan
          // that was about to work slower instead of more likely.
          const thorough = elapsed >= THOROUGH_AFTER_MS && framesTried % 3 === 0
          if (thorough) thoroughRuns += 1

          const value = firstPayload(
            await decoder.readBarcodes(
              pixels,
              readerOptions(thorough ? thoroughFormats : fastFormats, thorough)
            )
          )
          // The decoder ran. Whether or not a code was in shot, it is working.
          consecutiveErrors = 0
          if (value) {
            stop()
            resolve(value)
            return
          }

          // Nothing of the accepted kind. Now and then, look for the other kind too — not to
          // accept it, only so the dialog can say «a QR was seen; this field takes a barcode».
          if (
            otherFormats.length > 0 &&
            elapsed >= WRONG_KIND_PROBE_AFTER_MS &&
            framesTried % WRONG_KIND_PROBE_EVERY === 0
          ) {
            probeRuns += 1
            const seen = pickDetection(
              await decoder.readBarcodes(pixels, readerOptions(otherFormats, false)),
              []
            )
            // Recorded, never accepted: the field's rule stands.
            if (seen) ignoredFamily = seen.family
          }
        } catch (err) {
          lastError = describe(err)
          consecutiveErrors += 1
          if (decideOnDecodeError(consecutiveErrors) === 'giveUp') {
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
 * <p>Opens no camera: it loads the decoder and reports whether that succeeded. This is the page an
 * admin opens when an operator says scanning does not work, and the question it now answers is a
 * different and much smaller one than before. There is no longer a platform decoder whose absence
 * silently removes linear barcodes; there is one file that either loaded or did not.
 *
 * <p>`platformDetectorFormats` is kept, and is **reported only**. It is what
 * `BarcodeDetector.getSupportedFormats()` says on this device, which is useful for understanding a
 * tablet's history — on the devices this change was made for it answers with a plausible list and
 * then reads nothing — but nothing in the scan path consults it any more.
 */
export interface DecoderReport {
  decoder: DecoderName
  families: CodeFamily[]
  /** The ZXing build compiled in, so a device's answer names a version. */
  version: string
  /** Where the WebAssembly file is served from, for diagnosing a precache miss. */
  wasmUrl: string
  /** Whether the decoder loaded. `null` for the native-app reader, which has no such file. */
  loaded: boolean | null
  /** Why it did not load, when it did not. */
  error: string | null
  /** What the unused platform API claims, for context only. `[]` is its "unavailable". */
  platformDetectorFormats: string[] | null
}

export async function decoderReport(): Promise<DecoderReport> {
  const Detector = (
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as {
          BarcodeDetector?: { getSupportedFormats?: () => Promise<string[]> }
        }).BarcodeDetector
  )
  let platformDetectorFormats: string[] | null = null
  if (Detector && typeof Detector.getSupportedFormats === 'function') {
    try {
      platformDetectorFormats = await Detector.getSupportedFormats()
    } catch {
      platformDetectorFormats = []
    }
  }

  const zxing = await decoderModule()
  const { version, wasmUrl } = zxing.decoderIdentity()

  if (nativeQrAvailable()) {
    return {
      decoder: 'native-app',
      families: ['qr', 'barcode'],
      version,
      wasmUrl,
      loaded: null,
      error: null,
      platformDetectorFormats
    }
  }

  try {
    await zxing.loadDecoder()
    return {
      decoder: 'zxing',
      families: ['qr', 'barcode'],
      version,
      wasmUrl,
      loaded: true,
      error: null,
      platformDetectorFormats
    }
  } catch (err) {
    return {
      decoder: 'zxing',
      families: [],
      version,
      wasmUrl,
      loaded: false,
      // The wrapper's own message is already on the dialog; what the device check needs is the
      // cause underneath it — the HTTP status, or whatever the instantiation threw.
      error: describe(err instanceof zxing.DecoderUnavailableError ? err.cause : err),
      platformDetectorFormats
    }
  }
}
