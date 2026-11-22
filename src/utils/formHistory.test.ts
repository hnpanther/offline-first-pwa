import { describe, expect, it } from 'vitest'
import {
  formHistoryMustKeepLocal,
  isActiveFormSubmission,
  isHistoryFormSubmission
} from './formHistory'

describe('form history split', () => {
  it('keeps drafts and unsent finals active', () => {
    expect(isActiveFormSubmission({ status: 'draft', syncStatus: 'pending' })).toBe(true)
    expect(isActiveFormSubmission({ status: 'submitted', syncStatus: 'pending' })).toBe(true)
    expect(isHistoryFormSubmission({ status: 'draft', syncStatus: 'pending' })).toBe(false)
  })

  it('puts submitted, approved and voided filings in history, apart from active drafts', () => {
    expect(
      isHistoryFormSubmission({ status: 'submitted', syncStatus: 'synced', serverStatus: 'SUBMITTED' })
    ).toBe(true)
    expect(
      isHistoryFormSubmission({ status: 'submitted', syncStatus: 'synced', serverStatus: 'APPROVED' })
    ).toBe(true)
    expect(
      isHistoryFormSubmission({ status: 'submitted', syncStatus: 'synced', serverStatus: 'VOIDED' })
    ).toBe(true)
    expect(
      isHistoryFormSubmission({ status: 'submitted', syncStatus: 'failed', serverStatus: 'DRAFT' })
    ).toBe(true)
    expect(isActiveFormSubmission({ status: 'submitted', syncStatus: 'synced' })).toBe(false)
  })

  it('refuses to let history overwrite an unsynced draft or final', () => {
    expect(
      formHistoryMustKeepLocal({ status: 'draft', syncStatus: 'pending', locallyEditedAt: 1 })
    ).toBe(true)
    expect(
      formHistoryMustKeepLocal({ status: 'submitted', syncStatus: 'pending' })
    ).toBe(true)
    expect(
      formHistoryMustKeepLocal({ status: 'submitted', syncStatus: 'synced' })
    ).toBe(false)
  })
})
