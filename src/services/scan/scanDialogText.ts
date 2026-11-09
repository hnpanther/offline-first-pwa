import type { CodeFamily } from './qrScanner'

/**
 * What the scan dialog tells the operator, from what this scan accepts.
 *
 * <p>The instruction used to say «QR یا بارکد» whenever a field allowed a linear barcode —
 * including a field that allowed **only** a linear barcode. An operator read that, held up a QR
 * sticker, and watched a camera that never read anything, because the detector was looking for
 * linear symbologies alone. The words now say exactly what will be read.
 *
 * @param families what this scan accepts; `undefined` for identifying an asset, which is QR
 */
export function scanInstruction(families: CodeFamily[] | undefined): string {
  if (!families) return 'دوربین را روی برچسب QR دارایی بگیرید.'
  const qr = families.includes('qr')
  const barcode = families.includes('barcode')
  if (qr && barcode) return 'دوربین را روی برچسب QR یا بارکد بگیرید.'
  if (barcode) return 'دوربین را روی بارکد خطی بگیرید. این فیلد QR Code نمی‌پذیرد.'
  return 'دوربین را روی برچسب QR بگیرید.'
}

/** The default title, when the caller gives none. */
export function scanTitle(families: CodeFamily[] | undefined): string {
  const qr = !families || families.includes('qr')
  const barcode = !!families && families.includes('barcode')
  if (qr && barcode) return 'اسکن QR یا بارکد'
  if (barcode) return 'اسکن بارکد'
  return 'اسکن QR Code'
}

/**
 * The sentence for a code that was seen and is of a kind this scan does not take.
 *
 * Names what to do about it, because the operator cannot fix it on the tablet: the field's
 * accepted kinds are set in the panel.
 */
export function wrongKindMessage(seen: CodeFamily): string {
  return seen === 'qr'
    ? 'یک QR Code دیده شد، اما اینجا فقط بارکد خطی پذیرفته می‌شود. اگر برچسب این تجهیز QR است، تنظیم این فیلد باید در پنل اصلاح شود.'
    : 'یک بارکد خطی دیده شد، اما اینجا فقط QR Code پذیرفته می‌شود. اگر برچسب این تجهیز بارکد است، تنظیم این فیلد باید در پنل اصلاح شود.'
}
