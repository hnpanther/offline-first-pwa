import { describe, expect, it } from 'vitest'
import { WRONG_KIND_PROBE_EVERY } from './qrScanner'
import { scanInstruction, scanTitle, wrongKindMessage } from './scanDialogText'

/**
 * A field that accepts only a linear barcode was offered a dialog that said «QR یا بارکد», and a
 * detector that could not see a QR at all. An operator held up a QR sticker and watched a camera
 * that never read anything. These pin the two halves of the fix: the words say what will be read,
 * and a code of the wrong kind is named instead of ignored in silence.
 */
describe('the instruction names exactly what will be read', () => {
  it('never invites a QR on a barcode-only field', () => {
    const text = scanInstruction(['barcode'])
    expect(text).toContain('بارکد خطی')
    expect(text).toContain('QR Code نمی‌پذیرد')
    expect(scanTitle(['barcode'])).toBe('اسکن بارکد')
  })

  it('names both when both are accepted, and QR alone when only QR is', () => {
    expect(scanInstruction(['qr', 'barcode'])).toContain('QR یا بارکد')
    expect(scanInstruction(['qr'])).not.toContain('بارکد')
    expect(scanTitle(['qr', 'barcode'])).toBe('اسکن QR یا بارکد')
    expect(scanTitle(['qr'])).toBe('اسکن QR Code')
  })

  it('keeps the asset wording when identifying an asset', () => {
    expect(scanInstruction(undefined)).toContain('QR دارایی')
    expect(scanTitle(undefined)).toBe('اسکن QR Code')
  })
})

describe('a code of the wrong kind is named', () => {
  it('says which kind was seen and where it has to be fixed', () => {
    expect(wrongKindMessage('qr')).toContain('QR Code دیده شد')
    expect(wrongKindMessage('qr')).toContain('پنل')
    expect(wrongKindMessage('barcode')).toContain('بارکد خطی دیده شد')
  })
})

/**
 * The probe that produces the wrong-kind message costs a second decode of the same frame, so it
 * runs on a minority of them. `familyOfFormat` and `pickDetection` themselves are tested in
 * qrScanner.test.ts, against the decoder that actually reports those values.
 */
describe('the wrong-kind probe stays a minority of frames', () => {
  it('never runs on most frames', () => {
    expect(WRONG_KIND_PROBE_EVERY).toBeGreaterThanOrEqual(5)
  })
})
