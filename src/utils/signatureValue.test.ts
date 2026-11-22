import { describe, expect, it } from 'vitest'
import { buildSignatureValue, isServerStamped, signatureIdOf, signedAtOf } from './signatureValue'
import { attachmentIdsOf } from '@/services/storage/attachments'
import { isFieldValueBlank } from './formDataValidation'

describe('the signature value a device writes', () => {
  it('names one drawing and the device time — and nothing that claims a signer', () => {
    const v = buildSignatureValue('b94ecdd6-0000-4000-8000-000000000001', 1_790_000_000_000)
    expect(v).toEqual({ type: 'signature', ids: ['b94ecdd6-0000-4000-8000-000000000001'], signedAt: 1_790_000_000_000 })
    expect(Object.keys(v)).not.toContain('signedByUserId')
    expect(Object.keys(v)).not.toContain('answersHash')
  })

  it('is read by the attachment readers through `ids`, with no second case', () => {
    const v = buildSignatureValue('id-1', 1)
    expect(attachmentIdsOf(v)).toEqual(['id-1'])
    expect(signatureIdOf(v)).toBe('id-1')
  })

  it('counts as answered — the archive path must see a signed round as work (backend #179)', () => {
    expect(isFieldValueBlank(buildSignatureValue('id-1', 1), 'signature')).toBe(false)
    expect(isFieldValueBlank({ type: 'signature', ids: [] }, 'signature')).toBe(true)
    expect(isFieldValueBlank(undefined, 'signature')).toBe(true)
  })
})

describe('reading a value back', () => {
  it('knows an unsigned field', () => {
    expect(signatureIdOf(null)).toBeNull()
    expect(signatureIdOf({ type: 'signature', ids: [] })).toBeNull()
  })

  it('reads the signing time, tolerating a string from JSON', () => {
    expect(signedAtOf({ signedAt: 42 })).toBe(42)
    expect(signedAtOf({ signedAt: '42' })).toBe(42)
    expect(signedAtOf({ signedAt: 'x' })).toBeNull()
    expect(signedAtOf(null)).toBeNull()
  })

  it('tells a server-stamped signature from a drawing still on its way', () => {
    expect(isServerStamped(buildSignatureValue('a', 1))).toBe(false)
    expect(isServerStamped({ type: 'signature', ids: ['a'], signedAt: 1, signedByUserId: 7, answersHash: 'sha256:x', hashAlgo: 'v1' })).toBe(true)
  })
})
