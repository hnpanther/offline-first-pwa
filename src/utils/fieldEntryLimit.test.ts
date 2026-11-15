import { describe, expect, it } from 'vitest'
import {
  entryLimitError,
  entryLimitSummaryFa,
  entryRange,
  evaluateFieldSeverity,
  hasEntryLimit,
  isIntegerOnly
} from '@/utils/fieldValidation'
import { buildValidationRules } from '@/components/forms/DynamicClassForm'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import { describeSubmitBlockingIssues, findSubmitBlockingIssues } from '@/utils/formDataValidation'
import type { LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition, FieldValidation } from '@/types/sync'

/**
 * A number field's entry limit — `validation.entryRange` and `validation.integerOnly`, backend
 * roadmap §40. What a reading may be AT ALL, as against a band, which says what is normal.
 *
 * Three things matter and each has a section below:
 *
 *  1. it REFUSES — the form's rule will not save a value outside it — and it never colours:
 *     severity is untouched, because a refused value is never stored to be judged;
 *  2. it is never STRICTER than the server — every unreadable shape is «no limit», because a
 *     device that refuses what the server accepts strands a round with nobody able to fix it;
 *  3. a per-asset limit reaches the form, so the device refuses on the machine the
 *     administrator singled out rather than the server refusing at sync.
 */

const LAMPS: FieldValidation = { entryRange: { min: 0, max: 32 }, integerOnly: true }

describe('entryRange — read defensively', () => {
  it('reads a stored range', () => {
    expect(entryRange(LAMPS)).toEqual({ min: 0, max: 32 })
    expect(entryRange({ entryRange: { max: 8 } })).toEqual({ max: 8 })
  })

  it('is no limit when absent, malformed or inverted — never a field nobody can fill', () => {
    expect(entryRange(undefined)).toEqual({})
    expect(entryRange({})).toEqual({})
    expect(entryRange({ entryRange: 'x' } as unknown as FieldValidation)).toEqual({})
    expect(entryRange({ entryRange: { min: 'abc', max: '' } } as unknown as FieldValidation)).toEqual({})
    expect(entryRange({ entryRange: { min: 10, max: 2 } })).toEqual({})
  })

  it('is not the legacy top-level min/max, which is a WARNING band', () => {
    expect(entryRange({ min: 0, max: 10 })).toEqual({})
    expect(hasEntryLimit({ min: 0, max: 10 })).toBe(false)
  })

  it('turns integerOnly on only for a literal true', () => {
    expect(isIntegerOnly({ integerOnly: true })).toBe(true)
    expect(isIntegerOnly({ integerOnly: 'true' } as unknown as FieldValidation)).toBe(false)
    expect(isIntegerOnly({})).toBe(false)
    expect(isIntegerOnly(undefined)).toBe(false)
  })
})

describe('entryLimitError — what is refused, and the words for it', () => {
  it('refuses nothing on a field without a limit — every number field before §40', () => {
    const plain: FieldValidation = { warning: { min: 0, max: 10 } }
    expect(entryLimitError(1e9, plain)).toBeNull()
    expect(entryLimitError(-5, plain)).toBeNull()
    expect(entryLimitError(2.5, undefined)).toBeNull()
    expect(entryLimitError('abc', plain)).toBeNull()
  })

  it('leaves a blank value to `required`', () => {
    expect(entryLimitError('', LAMPS)).toBeNull()
    expect(entryLimitError('   ', LAMPS)).toBeNull()
    expect(entryLimitError(undefined, LAMPS)).toBeNull()
  })

  it('accepts the bounds themselves — the interval is closed, as the server`s is', () => {
    expect(entryLimitError(0, LAMPS)).toBeNull()
    expect(entryLimitError('32', LAMPS)).toBeNull()
    expect(entryLimitError(17, LAMPS)).toBeNull()
  })

  it('refuses outside the range, naming the range', () => {
    expect(entryLimitError(33, LAMPS)).toBe('مقدار باید بین 0 و 32 باشد.')
    expect(entryLimitError('-1', LAMPS)).toBe('مقدار باید بین 0 و 32 باشد.')
    expect(entryLimitError(9, { entryRange: { max: 8 } })).toBe('مقدار باید حداکثر 8 باشد.')
    expect(entryLimitError(-0.5, { entryRange: { min: 0 } })).toBe('مقدار باید حداقل 0 باشد.')
  })

  it('refuses a fraction on a whole-number field, and accepts 5.0', () => {
    expect(entryLimitError('2.5', LAMPS)).toBe('فقط عدد صحیح پذیرفته می‌شود.')
    expect(entryLimitError('5.0', LAMPS)).toBeNull()
    expect(entryLimitError(2.5, { integerOnly: true })).toBe('فقط عدد صحیح پذیرفته می‌شود.')
  })

  it('refuses something that is not a number on a limited field', () => {
    expect(entryLimitError('abc', LAMPS)).toBe('مقدار باید عدد باشد.')
  })
})

describe('entryLimitSummaryFa — the hint before anything is typed', () => {
  it('says the range and whether it is whole', () => {
    expect(entryLimitSummaryFa(LAMPS)).toBe('مجاز: 0–32، فقط عدد صحیح')
    expect(entryLimitSummaryFa({ entryRange: { min: 0 } })).toBe('مجاز: ≥ 0')
    expect(entryLimitSummaryFa({ entryRange: { max: 8 } })).toBe('مجاز: ≤ 8')
    expect(entryLimitSummaryFa({ integerOnly: true })).toBe('مجاز: فقط عدد صحیح')
    expect(entryLimitSummaryFa({ warning: { min: 1 } })).toBeNull()
  })
})

describe('a limit never touches severity', () => {
  it('judges an in-limit reading by its bands exactly as before', () => {
    const v: FieldValidation = { ...LAMPS, warning: { min: 2, max: 30 }, danger: { min: 1 } }
    expect(evaluateFieldSeverity('number', 31, v)).toBe('warning')
    expect(evaluateFieldSeverity('number', 0, v)).toBe('danger')
    expect(evaluateFieldSeverity('number', 10, v)).toBe('ok')
  })

  it('does not turn an out-of-limit value into a danger — it is refused, not judged', () => {
    expect(evaluateFieldSeverity('number', 40, LAMPS)).toBe('ok')
  })
})

// ---------------------------------------------------------------------------------------------

function def(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: '1',
    classId: '2',
    key: 'lamps',
    label: 'چراغ روشن',
    dataType: 'number',
    required: false,
    order: 1,
    deleted: false,
    ...overrides
  } as FieldDefinition
}

function runValidate(d: FieldDefinition, value: unknown): true | string {
  const validate = buildValidationRules(d).validate as ((v: unknown) => true | string) | undefined
  return validate ? validate(value) : true
}

describe('buildValidationRules — the form will not save a refused value', () => {
  it('refuses outside the limit with the message the field shows', () => {
    const d = def({ validation: LAMPS })
    expect(runValidate(d, '33')).toBe('مقدار باید بین 0 و 32 باشد.')
    expect(runValidate(d, '2.5')).toBe('فقط عدد صحیح پذیرفته می‌شود.')
    expect(runValidate(d, '32')).toBe(true)
  })

  it('accepts anything on a number field with no limit', () => {
    expect(runValidate(def({ validation: { warning: { max: 1 } } }), '1000')).toBe(true)
    expect(runValidate(def(), '-3.75')).toBe(true)
  })

  it('keeps `required` beside it', () => {
    const rules = buildValidationRules(def({ required: true, validation: LAMPS }))
    expect(rules.required).toBe('این فیلد الزامی است')
  })

  it('adds nothing to a field that is not a number', () => {
    expect(runValidate(def({ dataType: 'text', validation: LAMPS }), '999')).toBe(true)
  })
})

describe('a per-asset limit reaches the form', () => {
  const lamps = def({ classId: '7', validation: { entryRange: { min: 0, max: 8 }, integerOnly: true } })

  function sheetWith(overrides: Record<string, unknown>): LogSheet {
    return { fieldDefinitions: [lamps], fieldOverridesSnapshot: overrides } as unknown as LogSheet
  }

  it('gives the 32-lamp panel its own range and keeps the class`s integerOnly', () => {
    const sheet = sheetWith({
      '11': { source: 'RANGES_ONLY', fields: { lamps: { entryRange: { min: 0, max: 32 } } } }
    })
    const fields = sheetFieldDefinitions(sheet, '7', [], '11')
    expect(fields[0].validation?.entryRange).toEqual({ min: 0, max: 32 })
    expect(fields[0].validation?.integerOnly).toBe(true)
    expect(runValidate(fields[0], '20')).toBe(true)
  })

  it('leaves every other asset on the class range', () => {
    const sheet = sheetWith({
      '11': { source: 'RANGES_ONLY', fields: { lamps: { entryRange: { min: 0, max: 32 } } } }
    })
    const fields = sheetFieldDefinitions(sheet, '7', [], '12')
    expect(runValidate(fields[0], '20')).toBe('مقدار باید بین 0 و 8 باشد.')
  })

  it('drops the class range for an asset whose override says null', () => {
    const sheet = sheetWith({
      '11': { source: 'RANGES_ONLY', fields: { lamps: { entryRange: null } } }
    })
    const fields = sheetFieldDefinitions(sheet, '7', [], '11')
    expect(fields[0].validation?.entryRange).toBeUndefined()
    expect(runValidate(fields[0], '500')).toBe(true)
    expect(runValidate(fields[0], '2.5')).toBe('فقط عدد صحیح پذیرفته می‌شود.')
  })
})

describe('findSubmitBlockingIssues — a stored value outside the limit', () => {
  function entry(formData: Record<string, unknown>): LogSheetEntryData {
    return { assetId: '7', assetName: 'تابلو ۱', classId: '2', formData } as LogSheetEntryData
  }
  function sheetOf(formData: Record<string, unknown>): LogSheet {
    return { entries: [entry(formData)], fieldDefinitions: [def({ validation: LAMPS })] } as LogSheet
  }

  it('blocks the submit while the operator can still open the asset and fix it', () => {
    const issues = findSubmitBlockingIssues(sheetOf({ lamps: '40' }))
    expect(issues).toHaveLength(1)
    expect(issues[0].problem).toBe('مقدار باید بین 0 و 32 باشد.')
    expect(describeSubmitBlockingIssues(issues))
      .toBe('مقدار خارج از حد مجاز — تابلو ۱: چراغ روشن (مقدار باید بین 0 و 32 باشد.)')
  })

  it('allows a value inside the limit', () => {
    expect(findSubmitBlockingIssues(sheetOf({ lamps: 12 }))).toEqual([])
  })

  it('never blocks on a value it cannot read as a number — that is the server`s call', () => {
    expect(findSubmitBlockingIssues(sheetOf({ lamps: '5d' }))).toEqual([])
  })

  it('still words a missing required field exactly as before', () => {
    const issues = [{ assetId: '7', assetName: 'پمپ ۱', fieldLabel: 'دما' }]
    expect(describeSubmitBlockingIssues(issues)).toBe('فیلدهای الزامی تکمیل نشده‌اند — پمپ ۱: دما.')
  })
})
