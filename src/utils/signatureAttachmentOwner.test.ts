import { describe, expect, it } from 'vitest'
import {
  hasSignatureAttachmentOwner,
  signatureAttachmentOwner
} from '@/utils/signatureAttachmentOwner'

describe('signatureAttachmentOwner', () => {
  it('uses formSubmission keys only — never aliases into logSheetLocalId', () => {
    expect(
      signatureAttachmentOwner({
        formSubmissionLocalId: 'form-local-1',
        formSubmissionId: '42',
        assetId: 'should-be-dropped'
      })
    ).toEqual({
      formSubmissionLocalId: 'form-local-1',
      formSubmissionId: '42',
      assetId: undefined
    })
  })

  it('uses log-sheet keys for round signatures', () => {
    expect(
      signatureAttachmentOwner({
        logSheetLocalId: 'sheet-1',
        logSheetServerId: '9',
        assetId: 'asset-7'
      })
    ).toEqual({
      logSheetLocalId: 'sheet-1',
      logSheetServerId: '9',
      assetId: 'asset-7'
    })
  })

  it('requires exactly one owner lane', () => {
    expect(hasSignatureAttachmentOwner({ formSubmissionLocalId: 'f' })).toBe(true)
    expect(hasSignatureAttachmentOwner({ logSheetLocalId: 's' })).toBe(true)
    expect(hasSignatureAttachmentOwner({})).toBe(false)
    expect(
      hasSignatureAttachmentOwner({
        formSubmissionLocalId: 'f',
        logSheetLocalId: 's'
      })
    ).toBe(false)
  })
})
