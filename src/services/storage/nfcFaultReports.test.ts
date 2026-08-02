import { describe, expect, it } from 'vitest'
import { isNfcFaultReportOutboundOwnedByUser } from '@/services/storage/nfcFaultReports'

describe('isNfcFaultReportOutboundOwnedByUser', () => {
  it('allows sync when the report was created by the currently logged-in user', () => {
    expect(
      isNfcFaultReportOutboundOwnedByUser({ createdByUserId: '11' }, '11')
    ).toBe(true)
  })

  it('blocks sync when the report was created by a different user on a shared device', () => {
    // Reproduces the scenario: operator1 files a report offline and logs out before
    // it syncs; operator2 logs in on the same device. Operator1's pending report must
    // not be pushed under operator2's session.
    expect(
      isNfcFaultReportOutboundOwnedByUser({ createdByUserId: '11' }, '8')
    ).toBe(false)
  })

  it('treats a legacy record with no stamped owner as syncable (predates this field)', () => {
    expect(
      isNfcFaultReportOutboundOwnedByUser({ createdByUserId: undefined }, '8')
    ).toBe(true)
  })

  it('never syncs when nobody is currently logged in', () => {
    expect(
      isNfcFaultReportOutboundOwnedByUser({ createdByUserId: '11' }, null)
    ).toBe(false)
    expect(
      isNfcFaultReportOutboundOwnedByUser({ createdByUserId: undefined }, null)
    ).toBe(false)
  })
})
