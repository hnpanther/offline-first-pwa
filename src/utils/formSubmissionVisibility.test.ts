import { describe, expect, it } from 'vitest'
import {
  isFormSubmissionInAccessibleUnits,
  isFormSubmissionVisibleToSession
} from '@/utils/formSubmissionVisibility'

const row = (overrides: {
  createdByUserId?: string
  reporterUnitId?: string
  subjectUnitId?: string
} = {}) => ({
  createdByUserId: 'user-1',
  reporterUnitId: '10',
  subjectUnitId: '11',
  ...overrides
})

describe('form submission unit visibility', () => {
  it('hides another operator\'s row on a shared tablet', () => {
    expect(
      isFormSubmissionVisibleToSession(row({ createdByUserId: 'user-2' }), {
        userId: 'user-1',
        accessibleUnitIds: ['10', '11']
      })
    ).toBe(false)
  })

  it('shows own cross-unit filing when reporter unit is accessible', () => {
    expect(
      isFormSubmissionVisibleToSession(row({ reporterUnitId: '10', subjectUnitId: '99' }), {
        userId: 'user-1',
        accessibleUnitIds: ['10']
      })
    ).toBe(true)
  })

  it('shows own cross-unit filing when only the subject unit is accessible', () => {
    expect(
      isFormSubmissionVisibleToSession(row({ reporterUnitId: '99', subjectUnitId: '11' }), {
        userId: 'user-1',
        accessibleUnitIds: ['11']
      })
    ).toBe(true)
  })

  it('does not leak a row whose units are outside the session scope', () => {
    expect(
      isFormSubmissionVisibleToSession(row({ reporterUnitId: '20', subjectUnitId: '21' }), {
        userId: 'user-1',
        accessibleUnitIds: ['10', '11']
      })
    ).toBe(false)
  })

  it('plant-wide skips the unit filter but still requires ownership', () => {
    expect(
      isFormSubmissionVisibleToSession(row({ reporterUnitId: '20', subjectUnitId: '21' }), {
        userId: 'user-1',
        accessibleUnitIds: [],
        plantWide: true
      })
    ).toBe(true)
    expect(
      isFormSubmissionVisibleToSession(row({ createdByUserId: 'other' }), {
        userId: 'user-1',
        accessibleUnitIds: [],
        plantWide: true
      })
    ).toBe(false)
  })

  it('keeps own rows visible when unit cache is empty (pre-bootstrap)', () => {
    expect(
      isFormSubmissionVisibleToSession(row(), {
        userId: 'user-1',
        accessibleUnitIds: []
      })
    ).toBe(true)
  })

  it('unit intersection alone matches reporter or subject', () => {
    expect(isFormSubmissionInAccessibleUnits(row(), ['10'])).toBe(true)
    expect(isFormSubmissionInAccessibleUnits(row(), ['11'])).toBe(true)
    expect(isFormSubmissionInAccessibleUnits(row(), ['99'])).toBe(false)
    expect(isFormSubmissionInAccessibleUnits(row(), ['99'], true)).toBe(true)
  })
})
