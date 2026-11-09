import { describe, expect, it } from 'vitest'
import { editingHint, roundProgress, submittedHint } from './fillPageHints'

/**
 * The guides on the fill page must describe the round in front of the operator. Each case below
 * is one the old fixed sentences got wrong.
 */
describe('editingHint', () => {
  it('never mentions an Asset on a round that has none', () => {
    for (const scanMode of ['NFC', 'QR', 'NFC_OR_QR', 'NONE'] as const) {
      const hint = editingHint({ hasAssets: false, scanMode, allowManualEntry: true })
      expect(hint).not.toContain('Asset')
      expect(hint).not.toContain('NFC')
      expect(hint).toContain('پرسش‌های این کار')
    }
  })

  it('says nothing when the round needs no scan — that notice exists already', () => {
    expect(editingHint({ hasAssets: true, scanMode: 'NONE', allowManualEntry: false })).toBeNull()
    expect(editingHint({ hasAssets: true, scanMode: 'NONE', allowManualEntry: true })).toBeNull()
  })

  it('names the scan the round actually asks for', () => {
    const qr = editingHint({ hasAssets: true, scanMode: 'QR', allowManualEntry: false })!
    expect(qr).toContain('QR')
    expect(qr).not.toContain('NFC')

    const either = editingHint({ hasAssets: true, scanMode: 'NFC_OR_QR', allowManualEntry: false })!
    expect(either).toContain('NFC')
    expect(either).toContain('QR')

    const nfc = editingHint({ hasAssets: true, scanMode: 'NFC', allowManualEntry: false })!
    expect(nfc).toContain('تگ NFC')
    expect(nfc).not.toContain('QR')
  })

  it('offers typing the id when manual entry is allowed, and the fault report when it is not', () => {
    expect(editingHint({ hasAssets: true, scanMode: 'NFC', allowManualEntry: true })).toContain('دستی وارد')
    expect(editingHint({ hasAssets: true, scanMode: 'NFC', allowManualEntry: false })).toContain(
      'اعلام خرابی NFC'
    )
    // A QR-only round is not sent to a button about NFC tags.
    expect(editingHint({ hasAssets: true, scanMode: 'QR', allowManualEntry: false })).not.toContain(
      'اعلام خرابی'
    )
  })
})

describe('submittedHint', () => {
  it('points at the questions, not at assets, when there are none', () => {
    expect(submittedHint(false)).not.toContain('Asset')
    expect(submittedHint(false)).toContain('پرسش‌های این کار')
    expect(submittedHint(true)).toContain('Asset')
  })
})

describe('roundProgress', () => {
  it('counts assets on a round that has them, as it always did', () => {
    expect(roundProgress({ assetsTotal: 4, assetsDone: 1, questionKeys: ['a'], answers: { a: 'x' } })).toEqual({
      done: 1,
      total: 4,
      unit: 'Asset پر شده'
    })
  })

  it('counts answered questions on a round with no assets — never «0 / 0 Asset»', () => {
    const progress = roundProgress({
      assetsTotal: 0,
      assetsDone: 0,
      questionKeys: ['note', 'plate', 'checked', 'photos'],
      // A blank string, an empty list and an empty media value are not answers; a stale key
      // that is no longer a question is not counted either.
      answers: { note: 'تمیز', plate: '   ', checked: false, photos: { ids: [] }, removed: 'x' }
    })
    expect(progress).toEqual({ done: 2, total: 4, unit: 'پرسش پاسخ داده شده' })
    expect(progress.unit).not.toContain('Asset')
  })

  it('has nothing to measure when the round has neither', () => {
    expect(roundProgress({ assetsTotal: 0, assetsDone: 0, questionKeys: [], answers: {} }).total).toBe(0)
  })
})
