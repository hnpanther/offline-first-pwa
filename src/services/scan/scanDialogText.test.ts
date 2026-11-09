import { describe, expect, it } from 'vitest'
import { familyOfFormat, pickDetection, WRONG_KIND_PROBE_EVERY } from './qrScanner'
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

describe('familyOfFormat', () => {
  it('maps the platform format names onto the two kinds', () => {
    expect(familyOfFormat('qr_code')).toBe('qr')
    expect(familyOfFormat('code_128')).toBe('barcode')
    expect(familyOfFormat('ean_13')).toBe('barcode')
    // A detector that reports no format is treated as linear rather than as QR: a QR-only
    // caller then names it instead of accepting something it cannot vouch for.
    expect(familyOfFormat(undefined)).toBe('barcode')
  })
})

/**
 * Scanning stopped working after the wrong-kind change: every frame searched ten symbologies and
 * acted on whichever code came first, so a second code on the label — or a spurious linear read —
 * could set the wanted one aside on every frame. These pin the choice.
 */
describe('pickDetection', () => {
  it('takes the accepted kind even when another code is listed first', () => {
    const codes = [
      { rawValue: '0123', format: 'itf' },
      { rawValue: 'ASSET-7', format: 'qr_code' }
    ]
    expect(pickDetection(codes, ['qr'])).toEqual({ value: 'ASSET-7', family: 'qr' })
    expect(pickDetection(codes, ['barcode'])).toEqual({ value: '0123', family: 'barcode' })
  })

  it('reports a code of the other kind only when nothing acceptable is in the frame', () => {
    expect(pickDetection([{ rawValue: 'Q', format: 'qr_code' }], ['barcode'])).toEqual({
      value: 'Q',
      family: 'qr'
    })
    expect(pickDetection([], ['qr'])).toBeNull()
    expect(pickDetection([{ rawValue: '   ', format: 'qr_code' }], ['qr'])).toBeNull()
  })

  it('probes for the wrong kind on a minority of frames only', () => {
    expect(WRONG_KIND_PROBE_EVERY).toBeGreaterThanOrEqual(5)
  })
})
