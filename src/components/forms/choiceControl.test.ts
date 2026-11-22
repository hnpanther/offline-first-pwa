import { describe, expect, it } from 'vitest'
import {
  CHOICE_SEARCH_THRESHOLD,
  customAnswerProblem,
  findListedOption,
  isListedOption,
  planChoiceControl
} from './choiceControl'

const opts = (...values: string[]) => values.map(v => ({ value: v, label: v }))

describe('planChoiceControl', () => {
  it('a short list stays a list — faster read than searched', () => {
    expect(planChoiceControl(3, false)).toEqual({ searchable: false, freeEntry: false })
    expect(planChoiceControl(CHOICE_SEARCH_THRESHOLD, undefined)).toEqual({ searchable: false, freeEntry: false })
  })

  it('a long list is searched, automatically, with no setting', () => {
    expect(planChoiceControl(CHOICE_SEARCH_THRESHOLD + 1, false)).toEqual({ searchable: true, freeEntry: false })
  })

  it('free entry is the field\'s permission, and makes the control a combobox at any length', () => {
    expect(planChoiceControl(2, true)).toEqual({ searchable: true, freeEntry: true })
  })

  it('free entry needs a vocabulary to step outside of', () => {
    // A choice field with no options already accepts anything; the flag would say nothing.
    expect(planChoiceControl(0, true)).toEqual({ searchable: false, freeEntry: false })
  })

  it('only a literal true opens free entry — a blob this build cannot read stays narrow', () => {
    expect(planChoiceControl(2, 'true' as unknown as boolean).freeEntry).toBe(false)
  })
})

describe('isListedOption — «was this typed?», answered at read time', () => {
  it('a listed value is listed, trimmed like the server does', () => {
    expect(isListedOption(opts('قطع برق'), ' قطع برق ')).toBe(true)
  })

  it('anything else was typed', () => {
    expect(isListedOption(opts('قطع برق'), 'گیر کردن شیر برقی')).toBe(false)
    expect(isListedOption(opts('a'), null)).toBe(false)
  })
})

describe('findListedOption', () => {
  it('maps a spelling variant onto the listed option instead of creating a second answer', () => {
    expect(findListedOption(opts('کمپرسور'), 'كمپرسور')?.value).toBe('کمپرسور')
  })

  it('returns null when nothing is meant', () => {
    expect(findListedOption(opts('کمپرسور'), 'پمپ')).toBeNull()
    expect(findListedOption(opts('کمپرسور'), '   ')).toBeNull()
  })
})

describe('customAnswerProblem — the server\'s three rules, said before the sync', () => {
  it('accepts a short single-line phrase', () => {
    expect(customAnswerProblem('گیر کردن شیر برقی')).toBeNull()
  })

  it('refuses an empty one', () => {
    expect(customAnswerProblem('   ')).not.toBeNull()
  })

  it('refuses one longer than the server accepts, counting characters not UTF-16 units', () => {
    expect(customAnswerProblem('ب'.repeat(200))).toBeNull()
    expect(customAnswerProblem('ب'.repeat(201))).not.toBeNull()
  })

  it('refuses a line break or a control character', () => {
    expect(customAnswerProblem('a\nb')).not.toBeNull()
    expect(customAnswerProblem('a\u0000b')).not.toBeNull()
  })
})
