import { describe, it, expect } from 'vitest'
import {
  decideOnDecodeError,
  familyOfFormat,
  pickDetection,
  THOROUGH_AFTER_MS,
  WRONG_KIND_PROBE_AFTER_MS,
  type CodeFamily
} from './qrScanner'

/**
 * What is left to test after the decoder stopped being the platform's.
 *
 * <p>The scanner used to lead with `window.BarcodeDetector`, and most of this file tested the
 * machinery built to survive its absence: a format-list gate, a trial `detect()`, a mid-session
 * failover, a canvas rescue. All of it is gone, and so are its tests — not because they were
 * wrong, but because none of them could ever have worked. On an air-gapped Android handheld the
 * Play Services decoding module is never downloaded, and the way that surfaces is a detector that
 * constructs, lists formats, resolves every `detect()` call and returns an empty array for ever.
 * **Nothing reports a failure**, so every defence keyed on an error or on a declared capability
 * was waiting for a signal that does not come. Measured on the device: 434 frames, no errors,
 * no reads.
 *
 * <p>The decoder is now compiled into the app (`zxing-wasm`), which is what these tests really
 * pin: the decisions that remain are about what to do with a decoder that *is* there.
 */
describe('decideOnDecodeError', () => {
  it('retries a small number of failures', () => {
    // A frame can fail while the camera reconfigures. Ending the session on that would make the
    // scanner flaky, which is its own bug report.
    expect(decideOnDecodeError(1)).toBe('retry')
    expect(decideOnDecodeError(3)).toBe('retry')
    expect(decideOnDecodeError(11)).toBe('retry')
  })

  it('gives up once the decoder has failed too many times in a row', () => {
    // HALF OF THE ORIGINAL BUG. The old loop caught every error and always retried, so this
    // state ran for ever and the operator was told nothing at all.
    expect(decideOnDecodeError(12)).toBe('giveUp')
    expect(decideOnDecodeError(99)).toBe('giveUp')
  })

  it('has no failover outcome left to return', () => {
    // Deliberate: `'failover'` existed to escape the platform decoder, and there is no platform
    // decoder to escape. One decoder that is part of the app either works here or is broken for a
    // reason worth reporting — a second code path would only hide that again.
    for (const errors of [1, 5, 12, 50]) {
      expect(['retry', 'giveUp']).toContain(decideOnDecodeError(errors))
    }
  })
})

describe('familyOfFormat', () => {
  it('reads the QR family from the symbology root, not the format', () => {
    // Every QR variant reports the symbology `QRCode`, so one comparison covers Model 1, Model 2,
    // Micro QR and rMQR. Judging by the *format* name is how a correct QR got rejected once, on a
    // platform that spelled the format differently.
    expect(familyOfFormat('QRCode')).toBe('qr')
  })

  it('treats everything else as a linear barcode', () => {
    expect(familyOfFormat('Code128')).toBe('barcode')
    expect(familyOfFormat('EANUPC')).toBe('barcode')
    expect(familyOfFormat(undefined)).toBe('barcode')
  })
})

describe('pickDetection', () => {
  const qr = { text: 'TAG-1', symbology: 'QRCode' }
  const linear = { text: '4006381333931', symbology: 'EANUPC' }

  it('takes the accepted kind even when the other one is listed first', () => {
    // THE FIELD BUG. A nameplate can carry a QR and a linear barcode, and a decoder asked for
    // several symbologies can also report a spurious linear read off printed text. Taking
    // whichever came first set the wanted code aside on every frame the other one led — a camera
    // that sees the label and never reads it.
    expect(pickDetection([linear, qr], ['qr'])?.value).toBe('TAG-1')
    expect(pickDetection([qr, linear], ['barcode'])?.value).toBe('4006381333931')
  })

  it('still reports a code of a kind the caller does not accept', () => {
    // Not to accept it — the field's rule stands — but so the dialog can say «a QR was seen;
    // this field takes a barcode» instead of looking like a scanner that never reads anything.
    const seen = pickDetection([qr], ['barcode'])
    expect(seen?.family).toBe('qr')
    expect(seen?.value).toBe('TAG-1')
  })

  it('ignores empty and whitespace-only payloads', () => {
    // A decoder can return a result whose text is empty. Resolving the scan with '' would write
    // a blank into the field the operator was about to fill.
    expect(pickDetection([{ text: '', symbology: 'QRCode' }], ['qr'])).toBeNull()
    expect(pickDetection([{ text: '   ', symbology: 'QRCode' }], ['qr'])).toBeNull()
  })

  it('trims the payload and changes nothing else', () => {
    // The whole contract of a scan: the raw value the tag carries. A sticker printed from the
    // panel and one printed from a label machine must resolve to the same asset.
    expect(pickDetection([{ text: '  TAG-1  ', symbology: 'QRCode' }], ['qr'])?.value).toBe('TAG-1')
  })

  it('returns null for an empty frame', () => {
    const families: CodeFamily[] = ['qr', 'barcode']
    expect(pickDetection([], families)).toBeNull()
  })
})

describe('the escalation thresholds', () => {
  it('lets the cheap read run alone before the expensive one joins it', () => {
    // ZXing's defaults turn on rotation, inversion and tryHarder — right for a label somebody is
    // struggling with, wrong for the first second, when they only cost frames. A scan that works
    // at all works well inside this, so the common case never pays for the exceptions.
    expect(THOROUGH_AFTER_MS).toBeGreaterThan(0)
    expect(THOROUGH_AFTER_MS).toBeLessThan(WRONG_KIND_PROBE_AFTER_MS)
  })

  it('names a wrong-kind code only once the scan is already failing', () => {
    // The probe is a courtesy message and it costs a second decode of the frame. It must never
    // slow down the scans that were going to succeed.
    expect(WRONG_KIND_PROBE_AFTER_MS).toBeGreaterThanOrEqual(THOROUGH_AFTER_MS)
  })
})
