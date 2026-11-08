import { describe, it, expect } from 'vitest'
import {
  decideOnDecodeError,
  usableNativeFormats,
  type CodeFamily,
  type DecoderName
} from './qrScanner'

/**
 * The two decisions behind "the camera opens and nothing ever happens".
 *
 * <p>On Android the scanner was dead and reported nothing at all. Neither half of the cause was
 * exotic; both were a decision never made:
 *
 * <ol>
 *   <li>`window.BarcodeDetector` being defined was taken as proof it works. Per spec a platform
 *       that cannot detect barcodes still exposes the constructor and resolves
 *       `getSupportedFormats()` with an <b>empty list</b>, which nothing looked at.</li>
 *   <li>The frame loop caught every error and always retried. Right for one frame; for a
 *       permanently broken decoder it is an infinite silent loop.</li>
 * </ol>
 *
 * <p>Both now live in pure functions, tested here, so the fix is pinned without a camera, a DOM
 * or a device — and so the empty-list input in particular can never stop being handled.
 */
describe('usableNativeFormats', () => {
  it('refuses the platform decoder when it reports an empty format list', () => {
    // THE BUG. This is a platform saying "I cannot do this" in the only way the spec gives it,
    // and the old code heard "yes" and then swallowed a rejection per frame, forever.
    expect(usableNativeFormats(['qr'], [])).toBeNull()
  })

  it('refuses it when there is no format list at all', () => {
    // A platform with no getSupportedFormats, or one whose call failed. Same answer: the
    // bundled decoder is known to work, so an unknown one is never preferred to it.
    expect(usableNativeFormats(['qr'], null)).toBeNull()
    expect(usableNativeFormats(['qr'], undefined)).toBeNull()
  })

  it('uses it for QR when the platform lists qr_code', () => {
    const usable = usableNativeFormats(['qr'], ['qr_code', 'code_128'])

    expect(usable).not.toBeNull()
    expect(usable?.families).toEqual(['qr'])
    // Only what was asked for: a detector told to hunt code_128 as well spends every frame
    // looking for a symbology that is not on the label.
    expect(usable?.formats).toEqual(['qr_code'])
  })

  it('never asks for a format the platform did not list', () => {
    // A detector constructed with an unknown format is how a working decoder gets discarded.
    const usable = usableNativeFormats(['barcode'], ['code_128', 'ean_13'])

    expect(usable?.formats).toEqual(['code_128', 'ean_13'])
    expect(usable?.formats).not.toContain('upc_a')
  })

  it('narrows the families to what the platform can actually read', () => {
    // A field allowing both, on a device that only does QR. The honest answer is "QR here",
    // not "both" — the dialog and the device check both report this verbatim.
    const usable = usableNativeFormats(['qr', 'barcode'], ['qr_code'])

    expect(usable?.families).toEqual(['qr'])
    expect(usable?.formats).toEqual(['qr_code'])
  })

  it('refuses a barcode-only request on a QR-only platform', () => {
    // There is no fallback for a linear barcode: `jsqr` reads QR and nothing else. So this
    // must say no here, which is what makes the dialog refuse in words instead of opening a
    // camera that physically cannot read the label in the operator's hand.
    expect(usableNativeFormats(['barcode'], ['qr_code'])).toBeNull()
  })

  it('keeps the administrator\'s order when both families are usable', () => {
    const qrFirst = usableNativeFormats(['qr', 'barcode'], ['qr_code', 'code_128'])
    const barcodeFirst = usableNativeFormats(['barcode', 'qr'], ['qr_code', 'code_128'])

    expect(qrFirst?.formats[0]).toBe('qr_code')
    expect(barcodeFirst?.formats[0]).toBe('code_128')
  })
})

describe('decideOnDecodeError', () => {
  const state = (over: Partial<Parameters<typeof decideOnDecodeError>[0]> = {}) => ({
    decoder: 'native' as DecoderName,
    fallbackTried: false,
    wantsQr: true,
    consecutiveErrors: 1,
    ...over
  })

  it('fails over the first time the platform decoder throws on a real frame', () => {
    // A detector can pass its probe and still fail on a live video frame, because the Android
    // backing module is fetched on demand. One switch, immediately — not twelve retries first,
    // because those twelve frames are seconds of the operator holding a tablet at a sticker.
    expect(decideOnDecodeError(state())).toBe('failover')
  })

  it('does not fail over twice', () => {
    expect(decideOnDecodeError(state({ fallbackTried: true }))).toBe('retry')
  })

  it('does not fail over from the bundled decoder', () => {
    // There is nowhere to go: `jsqr` is the last resort.
    expect(decideOnDecodeError(state({ decoder: 'jsqr' }))).toBe('retry')
  })

  it('does not fail over when QR was not asked for', () => {
    // A barcode-only field cannot be served by the QR-only fallback, so switching would
    // guarantee failure while pretending to recover.
    expect(decideOnDecodeError(state({ wantsQr: false }))).toBe('retry')
  })

  it('retries a small number of failures', () => {
    // A frame can fail while the camera reconfigures. Ending the session on that would make
    // the scanner flaky, which is its own bug report.
    expect(decideOnDecodeError(state({ decoder: 'jsqr', consecutiveErrors: 3 }))).toBe('retry')
    expect(decideOnDecodeError(state({ decoder: 'jsqr', consecutiveErrors: 11 }))).toBe('retry')
  })

  it('gives up once the active decoder has failed too many times in a row', () => {
    // THE OTHER HALF OF THE BUG. The old loop had no such branch, so this state ran forever
    // and the operator was told nothing.
    expect(decideOnDecodeError(state({ decoder: 'jsqr', consecutiveErrors: 12 }))).toBe('giveUp')
    expect(decideOnDecodeError(state({ decoder: 'jsqr', consecutiveErrors: 99 }))).toBe('giveUp')
  })

  it('gives up on the platform decoder too, once failover is spent', () => {
    expect(
      decideOnDecodeError(state({ fallbackTried: true, consecutiveErrors: 12 }))
    ).toBe('giveUp')
  })

  it('never returns giveUp while a failover is still available', () => {
    // Order matters: trying the decoder that might work beats reporting failure, however many
    // times the broken one has thrown.
    for (const errors of [1, 5, 12, 50]) {
      expect(decideOnDecodeError(state({ consecutiveErrors: errors }))).toBe('failover')
    }
  })
})

describe('the two decisions together', () => {
  it('describes the reported Android device end to end', () => {
    // What the tablet in the plant actually did: BarcodeDetector present, empty format list.
    // Before the fix that produced a detector that rejected every frame and a loop that said
    // nothing. Now it never becomes the active decoder in the first place.
    const families: CodeFamily[] = ['qr']
    expect(usableNativeFormats(families, [])).toBeNull()

    // ...and had it instead passed the probe and failed later, the loop would move off it
    // rather than spin.
    expect(
      decideOnDecodeError({
        decoder: 'native',
        fallbackTried: false,
        wantsQr: true,
        consecutiveErrors: 1
      })
    ).toBe('failover')
  })
})
