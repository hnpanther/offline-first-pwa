import { describe, expect, it } from 'vitest'
import { persianFormDescription, persianFormTitle } from './persianFormTitle'

describe('persian form title', () => {
  it('keeps a Persian title and drops a leading code or English segment', () => {
    expect(persianFormTitle('گزارش تخلف')).toBe('گزارش تخلف')
    expect(persianFormTitle('HSE_VIOLATION / Safety observation / گزارش تخلف')).toBe('گزارش تخلف')
    expect(persianFormTitle('HSE_VIOLATION - گزارش تخلف')).toBe('گزارش تخلف')
  })

  it('hides an English-only title and an English description', () => {
    expect(persianFormTitle('Safety observation')).toBe('')
    expect(persianFormTitle('HSE_VIOLATION')).toBe('')
    expect(persianFormDescription('Filed in English')).toBe('')
    expect(persianFormDescription('شرح فارسی')).toBe('شرح فارسی')
  })
})
