import { describe, expect, it } from 'vitest'
import cases from './persianSearch.cases.json'
import { matchesSearch, normalizeForSearch } from './persianSearch'

/*
 * The shared table. The panel runs the same file (byte-identical copy) in
 * `src/test/js/choice-search.test.cjs`; if a case here has to change, it changes there too, or
 * the tablet and the panel stop finding the same options for the same search.
 */
describe('persianSearch — the table shared with the panel', () => {
  it.each(cases.normalize.map(c => [JSON.stringify(c.in), c.in, c.out] as const))(
    'normalizes %s',
    (_name, input, expected) => {
      expect(normalizeForSearch(input)).toBe(expected)
    }
  )

  it.each(cases.match.map(c => [c.option, c.query, c.match] as const))(
    'matches(%s, %s) is %s',
    (option, query, expected) => {
      expect(matchesSearch(option, query)).toBe(expected)
    }
  )
})

describe('persianSearch — what it must not do', () => {
  it('never changes a value it is not asked to compare', () => {
    // The normaliser is for matching only: the stored answer is the option exactly as sent.
    const option = 'كمپرسور ۱۲'
    normalizeForSearch(option)
    expect(option).toBe('كمپرسور ۱۲')
  })
})
