/**
 * Loading the bundled ZXing decoder — and the two things about it that decide whether scanning
 * works on a tablet that has never had a network.
 *
 * <h2>Why a bundled decoder at all</h2>
 *
 * The scanner used to lead with `window.BarcodeDetector`. On Android that API is backed by a
 * Google Play Services module which is **downloaded on demand**, so on an air-gapped handheld it
 * is never there. What made it expensive to diagnose is the shape of the failure: the constructor
 * exists, `getSupportedFormats()` answers with a real list, `detect()` resolves without throwing —
 * and returns an empty array for every frame, for ever. The camera opens, the operator aims at a
 * sticker, and nothing happens. Measured on the device: 434 frames, zero errors, zero reads, while
 * the phone's own camera app read the same label instantly.
 *
 * No amount of failover logic fixes that, because nothing reports a failure. The only fix is to
 * stop depending on a decoder that is fetched over a network this device does not have. ZXing is
 * compiled into the app, so «offline» stops being a condition it can fail under.
 *
 * <h2>Why the `.wasm` is fetched by hand instead of by `locateFile`</h2>
 *
 * `zxing-wasm` resolves its WebAssembly file through a jsDelivr URL baked in at **its** build
 * time. That default is a CDN fetch on first scan: on this fleet it is a guaranteed failure, and
 * the only sign of it would be a scan dialog that never starts. So the file is imported as an
 * asset (`?url`), which makes Vite emit it into `dist/assets/` under a content hash — one more
 * build output, served by the same nginx and copied into the APK by `cap sync` like every chunk.
 *
 * It is then read with `fetch` and handed over as `wasmBinary`, rather than pointed at with
 * `locateFile`. That is deliberate and it buys two things:
 *
 * <ul>
 *   <li>**No dependency on the Content-Type.** `locateFile` leads to
 *       `WebAssembly.instantiateStreaming`, which refuses anything not served as
 *       `application/wasm`. The APK does not go through nginx at all — Capacitor's asset loader
 *       guesses the type from the extension — so that header is not ours to guarantee in the one
 *       delivery that matters most here. Emscripten does fall back to a buffer on a bad type, but
 *       it falls back with a console warning on a device nobody is looking at.</li>
 *   <li>**A failure that says what failed.** A `fetch` we issue ourselves can be checked, so a
 *       missing or unprecached file produces {@link DecoderUnavailableError} naming the URL,
 *       instead of a rejected instantiation from inside a generated module.</li>
 * </ul>
 *
 * <h2>The precache rule this file depends on</h2>
 *
 * `vite.config.ts` must keep `wasm` in the workbox `globPatterns`. Without it the service worker
 * precaches every chunk, font and icon and silently leaves out the one file the scanner cannot
 * run without — so scanning would work exactly until the tablet left Wi-Fi, which is the state it
 * spends its whole life in. That is the single line standing between this and the bug it replaces,
 * and {@link https://vitejs.dev Vite} will not warn about it.
 */

import { prepareZXingModule, readBarcodes, ZXING_WASM_VERSION } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

/**
 * The decoder could not be loaded. Distinct from «nothing was read», which is ordinary.
 *
 * Its own type so the dialog can tell the operator something true: a read that found nothing is
 * about aim, light and focus, and this is about the app's own files.
 */
export class DecoderUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('رمزگشای کد در این دستگاه بارگذاری نشد. برنامه را یک بار به‌روزرسانی کنید.')
    this.name = 'DecoderUnavailableError'
  }
}

/**
 * A loaded decoder: the read call, and the two facts the device check reports about it.
 *
 * Handed back rather than exported as module bindings so that **this whole module** can be the
 * lazy boundary. `services/scan/qrScanner` is imported eagerly by the fill page — it has to be,
 * to decide whether to render the scan button at all — so anything it imports statically lands in
 * the main chunk. Reaching ZXing only through `await import('./zxingModule')` keeps its Emscripten
 * glue in a chunk of its own, loaded the first time somebody actually scans.
 */
export interface ScanDecoder {
  readBarcodes: typeof readBarcodes
  /** Which ZXing build is compiled in, so a device's answer names a version. */
  version: string
  /** Where the WebAssembly file is served from, for diagnosing a precache miss. */
  wasmUrl: string
}

/**
 * Memoised: one fetch and one instantiation per page load.
 *
 * Cleared again on failure, so a scan attempted while the file was briefly unreachable can
 * succeed on the next press rather than caching the failure for the life of the page.
 */
let loading: Promise<ScanDecoder> | null = null

/**
 * Fetches the WebAssembly file and instantiates the decoder.
 *
 * <p>Safe to call repeatedly and cheap after the first time. Callers should start it **beside**
 * `getUserMedia` rather than after it: the camera takes a few hundred milliseconds to come up, and
 * that is long enough to hide this entirely.
 *
 * @throws DecoderUnavailableError if the file cannot be read or the module cannot be built.
 */
export function loadDecoder(): Promise<ScanDecoder> {
  loading ??= (async () => {
    const response = await fetch(wasmUrl)
    if (!response.ok) {
      throw new Error(`${wasmUrl} → HTTP ${response.status}`)
    }
    const wasmBinary = await response.arrayBuffer()
    await prepareZXingModule({
      overrides: {
        wasmBinary,
        // Belt and braces. `wasmBinary` is what is actually used, and `zxingDecode.test.ts`
        // proves it by pointing this at an unreachable address and still decoding. But the
        // library's own default here is a jsDelivr URL, so if `wasmBinary` ever stopped being
        // honoured — an upgrade, a refactor — the fallback would be a CDN fetch on a device with
        // no network, and the symptom would be a scan dialog that never starts. Pointed at the
        // precached file instead, that same slip degrades to something that still works.
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path)
      },
      fireImmediately: true
    })
    return { readBarcodes, version: ZXING_WASM_VERSION, wasmUrl }
  })().catch(err => {
    loading = null
    throw new DecoderUnavailableError(err)
  })
  return loading
}

/**
 * The decoder's URL and version without loading anything.
 *
 * <p>Separate from {@link loadDecoder} because the device-check page has to name the file it could
 * not find — and the case where that matters is exactly the case where loading failed.
 */
export function decoderIdentity(): Pick<ScanDecoder, 'version' | 'wasmUrl'> {
  return { version: ZXING_WASM_VERSION, wasmUrl }
}
