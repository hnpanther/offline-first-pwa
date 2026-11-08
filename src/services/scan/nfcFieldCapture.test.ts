import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimNextTagForField,
  offerTagToField,
  releaseFieldTagClaim
} from '@/services/scan/nfcFieldCapture'
import type { NFCTagData } from '@/types'

/**
 * Who gets the next NFC tag — the round's asset list, or a field waiting to be filled.
 *
 * The failure this prevents is subtle and user-visible: a tag scanned to fill a «شماره سریال»
 * field is deliberately NOT an asset on the round, so without a claim the fill page's matcher
 * also sees it and answers «این تگ در این Log Sheet وجود ندارد». A correct scan, reported as an
 * error, with the field filled anyway — which is the worst pairing available.
 */

const tag = (id: string): NFCTagData => ({ serialNumber: id, records: [] }) as NFCTagData

beforeEach(() => releaseFieldTagClaim())

describe('claiming the next tag', () => {
  it('hands the tag to the field and tells the caller to stand down', () => {
    const field = vi.fn()
    claimNextTagForField(field)

    expect(offerTagToField(tag('A'))).toBe(true)
    expect(field).toHaveBeenCalledOnce()
  })

  it('leaves the tag to the asset matcher when no field is waiting', () => {
    // The ordinary case, and the one that must not regress: every tag on a normal round still
    // reaches the page.
    expect(offerTagToField(tag('A'))).toBe(false)
  })

  it('takes exactly one tag per claim', () => {
    const field = vi.fn()
    claimNextTagForField(field)

    expect(offerTagToField(tag('A'))).toBe(true)
    // The second tag belongs to the page again — a field asked for one tag, not for the reader.
    expect(offerTagToField(tag('B'))).toBe(false)
    expect(field).toHaveBeenCalledOnce()
  })

  it('clears the claim before running the handler', () => {
    // A handler that starts another scan must not be handed its own tag a second time.
    const seen: string[] = []
    claimNextTagForField(t => {
      seen.push(t.serialNumber!)
      expect(offerTagToField(tag('reentrant'))).toBe(false)
    })

    offerTagToField(tag('A'))
    expect(seen).toEqual(['A'])
  })
})

describe('releasing a claim', () => {
  it('releases only its own, so a replaced claim cannot silence the new one', () => {
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = claimNextTagForField(first)
    claimNextTagForField(second)

    // The first field unmounted after the second had already claimed. Clearing blindly here
    // would leave the second waiting for a tag nothing will ever deliver.
    releaseFirst()

    expect(offerTagToField(tag('A'))).toBe(true)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('is safe to call twice, and after the tag already arrived', () => {
    const field = vi.fn()
    const release = claimNextTagForField(field)
    offerTagToField(tag('A'))

    expect(() => {
      release()
      release()
    }).not.toThrow()
  })

  it('drops an outstanding claim when the page leaves', () => {
    const field = vi.fn()
    claimNextTagForField(field)

    releaseFieldTagClaim()

    // A claim that outlived its page would hand every later tag to a component that is gone.
    expect(offerTagToField(tag('A'))).toBe(false)
    expect(field).not.toHaveBeenCalled()
  })
})
