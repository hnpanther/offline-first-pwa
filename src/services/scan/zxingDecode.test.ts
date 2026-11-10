import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import {
  prepareZXingModule as prepareWriter,
  writeBarcode
} from 'zxing-wasm/writer'
import { FAST_FORMATS, familyOfFormat, readerOptions } from './qrScanner'

/**
 * Proof that the bundled decoder reads what an operator holds up.
 *
 * <h3>Why this test exists at all</h3>
 *
 * Every previous scanner bug passed the test suite. The platform `BarcodeDetector` was mocked, or
 * tested only through the pure functions that decided whether to use it, and the actual question —
 * «does a camera pointed at this label produce this string» — was answered only by a person
 * standing in a plant. That is how a decoder that returned an empty array for 434 consecutive
 * frames shipped behind a green suite.
 *
 * So this decodes real symbols. ZXing's **writer** draws a QR code and four linear barcodes, and
 * ZXing's **reader** — the one the app ships — reads them back, using
 * {@link readerOptions | the app's own reader options} rather than a copy of them. If the fast
 * per-frame pass stops reading a clean symbol, or `textMode` starts rewriting payloads, this
 * fails here instead of in somebody's hand.
 *
 * <h3>What it deliberately does not cover</h3>
 *
 * **Loading.** The app reads its `.wasm` from a URL Vite emits and workbox precaches; this test
 * reads the same file straight off disk with `fs`, because a `?url` import and a `fetch` of it
 * mean nothing under Node. That half is verified by the build (the file must appear in `sw.js`'s
 * precache manifest) and on a device. What is verified here is the half that was never verified at
 * all: that the decoder decodes.
 *
 * **Blur, glare, angle and distance.** A generated symbol is a perfect one. This says the decoder
 * works; it does not say a label in a plant is legible.
 */

const require = createRequire(import.meta.url)

/** The wasm files from `node_modules`, loaded the way Node can and the browser cannot. */
function wasmBinary(specifier: string): ArrayBuffer {
  const bytes = readFileSync(require.resolve(specifier))
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

/**
 * The writer hands back a one-channel bitmap; the reader wants RGBA.
 *
 * Expanded by hand rather than through a canvas, because there is no canvas here — and that is
 * the point of doing it this way: nothing in this test needs a DOM, so it runs in the same plain
 * Node environment as the rest of the suite.
 */
function toImageData(symbol: { data: Uint8ClampedArray; width: number; height: number }) {
  const rgba = new Uint8ClampedArray(symbol.width * symbol.height * 4)
  for (let i = 0; i < symbol.data.length; i += 1) {
    const luminance = symbol.data[i]
    rgba[i * 4] = luminance
    rgba[i * 4 + 1] = luminance
    rgba[i * 4 + 2] = luminance
    rgba[i * 4 + 3] = 255
  }
  return { data: rgba, width: symbol.width, height: symbol.height }
}

/**
 * An address nothing can be fetched from — the assertion this whole file rests on.
 *
 * `zxing-wasm` resolves its WebAssembly file through a jsDelivr URL baked in at **its** build
 * time, so the default behaviour of a fresh install is a CDN fetch on the first scan. On this
 * fleet that is a guaranteed failure whose only symptom is a scan dialog that never starts. The
 * app avoids it by handing over `wasmBinary` instead (see `zxingModule.ts`), and every test below
 * is also a check that `wasmBinary` really does win: port 1 on the loopback refuses instantly, so
 * if anything here fetched this URL, instantiation would fail and all eleven tests would go red.
 *
 * <p>**This has to be a bad URL and not a throwing stub.** Emscripten calls `locateFile` while
 * setting the module up, to compute the path it *would* use, and only later prefers `wasmBinary`
 * over fetching it — so a `locateFile` that throws fails during setup even though no request was
 * ever going to be made. That is a trap in both directions: `locateFile` being consulted is not
 * evidence of a fetch, and it not throwing is not evidence of offline safety. Only an
 * unreachable address distinguishes the two.
 */
const UNREACHABLE = 'http://127.0.0.1:1/never-fetched-'

beforeAll(() => {
  prepareZXingModule({
    overrides: {
      wasmBinary: wasmBinary('zxing-wasm/reader/zxing_reader.wasm'),
      locateFile: path => UNREACHABLE + path
    }
  })
  prepareWriter({
    overrides: {
      wasmBinary: wasmBinary('zxing-wasm/writer/zxing_writer.wasm'),
      locateFile: path => UNREACHABLE + path
    }
  })
})

/** Draws a symbol and reads it back with the options a real frame gets. */
async function roundTrip(
  format: string,
  payload: string,
  families: ('qr' | 'barcode')[]
) {
  // `scale: 4` and the quiet zones give the reader a symbol of the size a camera would see;
  // a 1-pixel-per-module image is not something any lens produces.
  const written = await writeBarcode(payload, {
    format,
    scale: 4,
    withQuietZones: true
  })
  expect(written.error, `writing ${format}`).toBeFalsy()

  const results = await readBarcodes(
    toImageData(written.symbol),
    readerOptions(families.flatMap(f => FAST_FORMATS[f]), false)
  )
  return results
}

describe('the bundled decoder reads a QR code', () => {
  it('returns the payload verbatim', async () => {
    // The whole contract of a scan: the value the tag carries, unchanged. An asset's QR holds
    // exactly what `asset_entries.nfc_tag_id` holds, so any transformation here would make a
    // sticker printed from the panel resolve to a different asset than one from a label machine.
    const results = await roundTrip('QRCode', 'TAG-ABC-123', ['qr'])

    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('TAG-ABC-123')
    expect(familyOfFormat(results[0].symbology)).toBe('qr')
  })

  it('reads a payload with the structured content a GS1 label carries', async () => {
    // `textMode: 'Plain'` is load-bearing and invisible. ZXing's own default is `'HRI'`, which
    // rewrites GS1 content with bracketed application identifiers — so a sheet whose tag id
    // happens to look like that would come back reformatted and match nothing stored.
    const payload = '0104006381333931'
    const results = await roundTrip('QRCode', payload, ['qr'])

    expect(results[0].text).toBe(payload)
  })

  it('reads a long payload, as a dense sticker produces', async () => {
    const payload = 'PUMP-UNIT-7/BEARING-OUTBOARD/2026-11-10/SN-884412-REV-C'
    const results = await roundTrip('QRCode', payload, ['qr'])

    expect(results[0].text).toBe(payload)
  })
})

/**
 * The capability that did not exist before this decoder.
 *
 * <p>The old fallback was `jsqr`, which reads QR and no linear symbology whatsoever, so on a
 * handheld with no Play Services module a field set to `BARCODE` could not be scanned at all:
 * the platform decoder was blind and the fallback did not implement the format. Every case below
 * is a label that used to be unreadable on these devices.
 */
describe('the bundled decoder reads linear barcodes', () => {
  it.each([
    ['Code128', 'ASSET-7'],
    ['Code39', 'TAG-1'],
    ['Code93', 'VALVE12'],
    ['EAN13', '4006381333931'],
    ['ITF', '1234567890']
  ])('reads %s', async (format, payload) => {
    const results = await roundTrip(format, payload, ['barcode'])

    expect(results).toHaveLength(1)
    expect(results[0].text).toBe(payload)
    expect(familyOfFormat(results[0].symbology)).toBe('barcode')
  })
})

describe('a scan only accepts the kind its field allows', () => {
  it('does not read a QR when the field accepts linear barcodes only', async () => {
    // Not an accident of the format list — the rule. A field whose administrator allowed only a
    // linear barcode must not silently accept a QR, and the dialog says so in words instead.
    const results = await roundTrip('QRCode', 'TAG-ABC-123', ['barcode'])

    expect(results).toHaveLength(0)
  })

  it('does not read a linear barcode when the field accepts QR only', async () => {
    const results = await roundTrip('Code128', 'ASSET-7', ['qr'])

    expect(results).toHaveLength(0)
  })

  it('reads either when the field allows both', async () => {
    const both: ('qr' | 'barcode')[] = ['qr', 'barcode']

    expect((await roundTrip('QRCode', 'TAG-ABC-123', both))[0].text).toBe('TAG-ABC-123')
    expect((await roundTrip('Code128', 'ASSET-7', both))[0].text).toBe('ASSET-7')
  })
})
