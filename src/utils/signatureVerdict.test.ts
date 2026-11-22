import { describe, expect, it } from 'vitest'
import {
  coveredFingerprint,
  scopeOfField,
  scopeOfValue,
  signatureBaselines,
  signatureVerdict
} from './signatureVerdict'
import type { FieldDefinition } from '@/types/sync'
import type { LogSheetEntryData } from '@/types'

const sign = (extra: Record<string, unknown> = {}) => ({ type: 'signature', ids: ['d1'], ...extra })

describe('coveredFingerprint — a device-only fingerprint, compared only with itself', () => {
  it('does not depend on how a reading was typed, nor on blank fields', () => {
    const typed = coveredFingerprint('FORM', { pressure: '12', note: 'ok', empty: '', sign: sign() }, undefined)
    const stored = coveredFingerprint('FORM', { pressure: 12, note: ' ok ' }, undefined)
    expect(typed).toBe(stored)
  })

  it('changes when a covered answer changes', () => {
    expect(coveredFingerprint('FORM', { pressure: 12 }, undefined))
      .not.toBe(coveredFingerprint('FORM', { pressure: 13 }, undefined))
  })

  it('leaves out a live form\'s controls that are not this form\'s fields', () => {
    expect(coveredFingerprint('FORM', { pressure: 12, stray: 'x' }, ['pressure']))
      .toBe(coveredFingerprint('FORM', { pressure: 12 }, ['pressure']))
  })

  it('a ROUND signature also covers every asset, in an order the rows cannot change', () => {
    const a = [{ assetId: '2', formData: { t: 1 } }, { assetId: '10', formData: { t: 2 } }]
    const b = [a[1], a[0]]
    expect(coveredFingerprint('ROUND', { note: 'x' }, ['note'], a))
      .toBe(coveredFingerprint('ROUND', { note: 'x' }, ['note'], b))
    const changed = [{ assetId: '2', formData: { t: 9 } }, a[1]]
    expect(coveredFingerprint('ROUND', { note: 'x' }, ['note'], changed))
      .not.toBe(coveredFingerprint('ROUND', { note: 'x' }, ['note'], a))
    // FORM ignores the assets entirely.
    expect(coveredFingerprint('FORM', { note: 'x' }, ['note'], changed))
      .toBe(coveredFingerprint('FORM', { note: 'x' }, ['note'], a))
  })
})

describe('signatureVerdict', () => {
  it('a NONE signature is never out of date', () => {
    expect(signatureVerdict({ scope: 'NONE', serverState: 'STALE', current: 'x' })).toBe('not-bound')
  })

  it('the server saying STALE is shown', () => {
    expect(signatureVerdict({ scope: 'FORM', serverState: 'STALE', current: 'x' })).toBe('stale')
  })

  it('an answer changed on this tablet after a VALID signature arrived is caught before the next sync', () => {
    expect(signatureVerdict({ scope: 'FORM', serverState: 'VALID', baseline: 'a', current: 'b' })).toBe('stale')
    expect(signatureVerdict({ scope: 'FORM', serverState: 'VALID', baseline: 'a', current: 'a' })).toBe('valid')
  })

  it('a signature drawn on this device is judged by its own fingerprint until the server replaces it', () => {
    expect(signatureVerdict({ scope: 'FORM', localFingerprint: 'a', current: 'a' })).toBe('unknown')
    expect(signatureVerdict({ scope: 'FORM', localFingerprint: 'a', current: 'b' })).toBe('stale')
  })

  it('claims nothing it does not know', () => {
    expect(signatureVerdict({ scope: 'FORM', current: 'x' })).toBe('unknown')
  })
})

describe('scopes', () => {
  it('the field declares it; FORM by default; a recorded scope wins', () => {
    expect(scopeOfField(undefined)).toBe('FORM')
    expect(scopeOfField({ validation: { signatureScope: 'ROUND' } } as unknown as FieldDefinition)).toBe('ROUND')
    expect(scopeOfValue(sign({ scope: 'NONE' }), 'ROUND')).toBe('NONE')
    expect(scopeOfValue(sign(), 'ROUND')).toBe('ROUND')
  })
})

describe('signatureBaselines — taken only from answers the server delivered', () => {
  const questions = [
    { key: 'note', dataType: 'text' },
    { key: 'sign', dataType: 'signature', validation: { signatureScope: 'ROUND' } }
  ] as unknown as FieldDefinition[]
  const entries = [{ assetId: '7', formData: { t: 1, s: sign() } }] as unknown as LogSheetEntryData[]

  it('records a baseline for a VALID signature, per owner', () => {
    const out = signatureBaselines({
      states: { 'sheet:sign': 'VALID', '7:s': 'VALID', '7:x': 'STALE' },
      sheetFormData: { note: 'x', sign: sign({ scope: 'ROUND' }) },
      sheetFields: questions,
      sheetFormFromServer: true,
      entries
    })
    expect(Object.keys(out).sort()).toEqual(['7:s', 'sheet:sign'])
  })

  it('takes none where this device\'s own edits won the merge', () => {
    const edited = [{ assetId: '7', formData: { t: 2 }, locallyEditedAt: 1 }] as unknown as LogSheetEntryData[]
    const out = signatureBaselines({
      states: { 'sheet:sign': 'VALID', '7:s': 'VALID' },
      sheetFormData: { note: 'x', sign: sign({ scope: 'ROUND' }) },
      sheetFields: questions,
      sheetFormFromServer: true,
      entries: edited
    })
    // The ROUND signature covers the edited asset, and the asset's own answers were edited.
    expect(out).toEqual({})
  })
})
