import type { AssetScanMode } from '@/types'
import { isValueFilled } from '@/utils/entryTimestamps'

/**
 * The one-line guides on the fill page, chosen from what the round actually is.
 *
 * They used to be two fixed sentences, both written for a round of assets identified by NFC —
 * which was every round when they were written. Since then a round can identify its assets by QR,
 * by either, or by nothing, and a round can have no assets at all. The fixed sentences told an
 * operator on a questions-only round to «click an Asset» that did not exist, told one on a QR round
 * to scan an NFC tag, and contradicted the "no scan needed" notice on a round that needs none.
 * Kept pure so each of those cases is a test rather than a screen someone has to open.
 */

export interface EditingHintInput {
  hasAssets: boolean
  scanMode: AssetScanMode
  allowManualEntry: boolean
}

/**
 * The guide shown while the round can be edited, or `null` when another notice already says it
 * — a round whose assets need no scan has its own «این کار اسکن نیاز ندارد» line, and a second,
 * contradictory one beside it is how the old text read.
 */
export function editingHint({ hasAssets, scanMode, allowManualEntry }: EditingHintInput): string | null {
  if (!hasAssets) {
    return 'این کار دارایی ندارد؛ به «پرسش‌های این کار» پاسخ دهید، «ذخیره پرسش‌ها» را بزنید و سپس ارسال کنید.'
  }
  if (scanMode === 'NONE') return null

  const scan =
    scanMode === 'QR'
      ? 'برچسب QR آن را اسکن کنید'
      : scanMode === 'NFC_OR_QR'
        ? 'تگ NFC یا برچسب QR آن را اسکن کنید'
        : 'تگ NFC آن را اسکن کنید'
  const base = `برای مشاهده روی Asset کلیک کنید. برای ویرایش، ${scan}`

  if (allowManualEntry) return `${base} یا شناسه را دستی وارد کنید.`
  // The fault report is named for NFC, and a damaged tag is what it is for; on a QR-only round
  // pointing at it would send the operator to a button about the wrong thing.
  if (scanMode !== 'QR') {
    return `${base}. اگر تگ خراب است، با «اعلام خرابی NFC» ثبت دستی همان Asset باز می‌شود.`
  }
  return `${base}.`
}

/** The notice on a round that has been sent. */
export function submittedHint(hasAssets: boolean): string {
  return hasAssets
    ? 'این Log Sheet ارسال شده است. برای مشاهده اطلاعات روی هر Asset کلیک کنید.'
    : 'این Log Sheet ارسال شده است. پاسخ‌ها در «پرسش‌های این کار» قابل مشاهده است.'
}

export interface RoundProgressInput {
  assetsTotal: number
  assetsDone: number
  /** The keys of the round's own questions, in the order shown. */
  questionKeys: string[]
  answers: Record<string, unknown>
}

export interface RoundProgress {
  done: number
  total: number
  unit: string
}

/**
 * What the progress bar counts. A round of assets is measured by its assets, as it always was. A
 * round with none is measured by its own questions — it used to read «0 / 0 Asset پر شده», a count
 * of a thing the round does not have, and the bar never moved however much was answered. A
 * `total` of 0 means there is nothing to measure and the bar is not drawn.
 */
export function roundProgress({ assetsTotal, assetsDone, questionKeys, answers }: RoundProgressInput): RoundProgress {
  if (assetsTotal > 0) return { done: assetsDone, total: assetsTotal, unit: 'Asset پر شده' }
  return {
    done: questionKeys.filter(key => isValueFilled(answers[key])).length,
    total: questionKeys.length,
    unit: 'پرسش پاسخ داده شده'
  }
}
