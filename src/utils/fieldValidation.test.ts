import { describe, it, expect } from 'vitest'
import {
  evaluateNumericSeverity,
  warningRange,
  dangerRange,
  validationSummaryFa,
  severityMessage,
  filterNumericInput,
  normalizeNumericOnBlur,
  formatNumericDisplay,
  toggleNumericSign
} from './fieldValidation'

/**
 * Numeric fields: what may be typed, and how it is judged.
 *
 * These two questions used to be tangled together. A minus sign was accepted only when the
 * warning or danger range happened to have a negative minimum, so a reading that is genuinely
 * below zero — a temperature, a vacuum, a level under datum — could not be entered at all unless
 * somebody had configured a negative threshold first. The operator's only option was to record a
 * wrong number.
 *
 * They are now separate and stay separate: **every** number field is signed, and the ranges decide
 * severity alone. The severity half of this file is deliberately heavy, because that is the half
 * that must not have moved — it drives the colour an operator sees, the `max_severity` column, the
 * exceptions report and every KPI built on it. The cases below walk both sides of both boundaries,
 * with negative, zero and positive readings, and mirror the backend's `FieldValidationSupport`
 * exactly: danger is tested first, then warning, then OK.
 */

/** The nested shape the backend writes and the app reads. */
const ranges = (warn?: [number | null, number | null], danger?: [number | null, number | null]) => {
  const out: Record<string, unknown> = {}
  if (warn) out.warning = { min: warn[0] ?? undefined, max: warn[1] ?? undefined }
  if (danger) out.danger = { min: danger[0] ?? undefined, max: danger[1] ?? undefined }
  return out
}

describe('evaluateNumericSeverity — the judgement that must not move', () => {
  const validation = ranges([10, 20], [5, 25])

  it('inside every band is ok', () => {
    expect(evaluateNumericSeverity(15, validation)).toBe('ok')
  })

  it('the warning boundaries are inclusive on both ends', () => {
    // A reading exactly on the limit is within the limit. Off-by-one here would flag a whole
    // plant's worth of on-spec readings.
    expect(evaluateNumericSeverity(10, validation)).toBe('ok')
    expect(evaluateNumericSeverity(20, validation)).toBe('ok')
  })

  it('just outside the warning band is a warning, on both sides', () => {
    expect(evaluateNumericSeverity(9.9, validation)).toBe('warning')
    expect(evaluateNumericSeverity(20.1, validation)).toBe('warning')
  })

  it('the danger boundaries are inclusive too, and still warn', () => {
    // 5 and 25 are inside danger but outside warning: warning, not danger.
    expect(evaluateNumericSeverity(5, validation)).toBe('warning')
    expect(evaluateNumericSeverity(25, validation)).toBe('warning')
  })

  it('just outside the danger band is danger, on both sides', () => {
    expect(evaluateNumericSeverity(4.9, validation)).toBe('danger')
    expect(evaluateNumericSeverity(25.1, validation)).toBe('danger')
  })

  it('danger wins over warning — it is tested first', () => {
    // 100 is outside both. The operator must see the worse of the two.
    expect(evaluateNumericSeverity(100, validation)).toBe('danger')
  })

  // ── the readings that could not be entered before ────────────────────────────

  it('a negative reading is judged by the same rules, not rejected', () => {
    expect(evaluateNumericSeverity(-1, validation)).toBe('danger')
    expect(evaluateNumericSeverity(-273.15, validation)).toBe('danger')
  })

  it('a negative reading inside a negative band is ok', () => {
    // A field that legitimately runs below zero: −20…−5 normal, −30…0 before danger.
    const subZero = ranges([-20, -5], [-30, 0])
    expect(evaluateNumericSeverity(-12, subZero)).toBe('ok')
    expect(evaluateNumericSeverity(-20, subZero)).toBe('ok')
    expect(evaluateNumericSeverity(-5, subZero)).toBe('ok')
  })

  it('a negative reading warns and endangers on the correct side of a negative band', () => {
    const subZero = ranges([-20, -5], [-30, 0])
    expect(evaluateNumericSeverity(-25, subZero)).toBe('warning')
    expect(evaluateNumericSeverity(-2, subZero)).toBe('warning')
    expect(evaluateNumericSeverity(-31, subZero)).toBe('danger')
    expect(evaluateNumericSeverity(1, subZero)).toBe('danger')
  })

  it('zero is a value, not an absence', () => {
    // `0` is falsy in JavaScript and this is exactly where that bites.
    expect(evaluateNumericSeverity(0, ranges([0, 10]))).toBe('ok')
    expect(evaluateNumericSeverity(0, ranges([1, 10]))).toBe('warning')
    expect(evaluateNumericSeverity('0', ranges([1, 10]))).toBe('warning')
  })

  it('minus zero is zero', () => {
    expect(evaluateNumericSeverity(-0, ranges([0, 10]))).toBe('ok')
    expect(evaluateNumericSeverity('-0', ranges([0, 10]))).toBe('ok')
  })

  // ── partial ranges and no range at all ───────────────────────────────────────

  it('a one-sided band constrains only that side', () => {
    expect(evaluateNumericSeverity(-500, ranges([null, 20]))).toBe('ok')
    expect(evaluateNumericSeverity(21, ranges([null, 20]))).toBe('warning')
    expect(evaluateNumericSeverity(500, ranges([10, null]))).toBe('ok')
    expect(evaluateNumericSeverity(-1, ranges([10, null]))).toBe('warning')
  })

  it('a field with no ranges is always ok, including when negative', () => {
    // The common case now that any number field accepts a sign: nothing is configured, so
    // nothing is a breach. It must not become an error either.
    expect(evaluateNumericSeverity(-42, undefined)).toBe('ok')
    expect(evaluateNumericSeverity(-42, {})).toBe('ok')
    expect(evaluateNumericSeverity(42, {})).toBe('ok')
  })

  it('an empty range object is not a constraint', () => {
    expect(evaluateNumericSeverity(-99, { warning: {}, danger: {} })).toBe('ok')
  })

  it('a blank or unparseable reading is ok, never a breach', () => {
    // An untouched field must not colour itself red. This is the same rule the backend applies
    // when it leaves max_severity NULL for an entry nobody filled.
    for (const value of ['', null, undefined, '   ', 'abc', '-', NaN, Infinity]) {
      expect(evaluateNumericSeverity(value, validation)).toBe('ok')
    }
  })

  it('a whitespace-only reading is absent, not a reading of zero', () => {
    // `Number('')` is 0, so this used to evaluate as 0 — a DANGER against a 5–25 band. The
    // backend's Double.parseDouble throws on the same input and returns null, so the app painted
    // a field red that the server's stored max_severity called clean.
    expect(evaluateNumericSeverity('   ', validation)).toBe('ok')
    expect(evaluateNumericSeverity('	', validation)).toBe('ok')
  })

  it('a blank range bound means no bound, not a bound of zero', () => {
    // Same root cause on the other side of the comparison.
    expect(evaluateNumericSeverity(-500, { warning: { min: '', max: 20 } })).toBe('ok')
    expect(evaluateNumericSeverity(21, { warning: { min: '', max: 20 } })).toBe('warning')
  })

  it('a numeric string is judged like the number it spells', () => {
    expect(evaluateNumericSeverity('-1', validation)).toBe('danger')
    expect(evaluateNumericSeverity(' 15 ', validation)).toBe('ok')
    expect(evaluateNumericSeverity('9.9', validation)).toBe('warning')
  })

  it('the legacy flat min/max still reads as the warning band', () => {
    // Rows written before nested ranges existed. The backend treats these as warning; so must we,
    // or history would be re-judged differently by the two clients.
    expect(evaluateNumericSeverity(5, { min: 10, max: 20 })).toBe('warning')
    expect(evaluateNumericSeverity(15, { min: 10, max: 20 })).toBe('ok')
    expect(evaluateNumericSeverity(-5, { min: 10, max: 20 })).toBe('warning')
  })

  it('a nested band takes precedence over the legacy flat one', () => {
    const mixed = { min: 0, max: 1, warning: { min: 10, max: 20 } }
    expect(evaluateNumericSeverity(15, mixed)).toBe('ok')
  })
})

describe('range readers', () => {
  it('read both bands', () => {
    const v = ranges([10, 20], [5, 25])
    expect(warningRange(v)).toEqual({ min: 10, max: 20 })
    expect(dangerRange(v)).toEqual({ min: 5, max: 25 })
  })

  it('return an empty range rather than throwing on nothing', () => {
    expect(warningRange(undefined)).toEqual({})
    expect(dangerRange(undefined)).toEqual({})
    expect(dangerRange({ warning: { min: 1 } })).toEqual({})
  })

  it('keep negative bounds intact', () => {
    expect(warningRange(ranges([-20, -5]))).toEqual({ min: -20, max: -5 })
  })
})

describe('validationSummaryFa — the hint under the field', () => {
  it('shows both bands', () => {
    expect(validationSummaryFa(ranges([10, 20], [5, 25]))).toBe('هشدار: 10–20 · خطر: 5–25')
  })

  it('shows a one-sided band with the right comparison', () => {
    expect(validationSummaryFa(ranges([10, null]))).toBe('هشدار: ≥ 10')
    expect(validationSummaryFa(ranges([null, 20]))).toBe('هشدار: ≤ 20')
  })

  it('shows negative bounds as they are', () => {
    expect(validationSummaryFa(ranges([-20, -5]))).toBe('هشدار: -20–-5')
  })

  it('is null when there is nothing to say', () => {
    expect(validationSummaryFa(undefined)).toBeNull()
    expect(validationSummaryFa({})).toBeNull()
  })
})

describe('severityMessage', () => {
  it('speaks only for a breach', () => {
    expect(severityMessage('ok')).toBeNull()
    expect(severityMessage('warning')).toBe('خارج از بازه هشدار است.')
    expect(severityMessage('danger')).toBe('خارج از بازه خطر است.')
  })
})

describe('filterNumericInput — every field is signed now', () => {
  it('accepts a leading minus', () => {
    expect(filterNumericInput('-5')).toBe('-5')
    expect(filterNumericInput('-0.5')).toBe('-0.5')
  })

  it('accepts a lone minus while the operator is still typing', () => {
    // Stripping it here would make the key appear dead. normalizeNumericOnBlur clears it later
    // if nothing follows.
    expect(filterNumericInput('-')).toBe('-')
  })

  it('survives typing a negative decimal one keystroke at a time', () => {
    const keys = ['-', '-1', '-1.', '-1.2', '-1.25']
    const results = keys.map(k => filterNumericInput(k))
    expect(results).toEqual(['-', '-1', '-1.', '-1.2', '-1.25'])
  })

  it('allows a minus on a field with no ranges at all', () => {
    // The whole point of the change: what may be typed no longer depends on configuration.
    expect(filterNumericInput('-7')).toBe('-7')
  })

  it('refuses a minus anywhere but the front', () => {
    expect(filterNumericInput('5-3')).toBe('53')
    expect(filterNumericInput('--5')).toBe('-5')
  })

  it('keeps a single decimal point', () => {
    expect(filterNumericInput('1.2.3')).toBe('1.23')
    expect(filterNumericInput('.5')).toBe('.5')
  })

  it('drops letters and symbols from a paste', () => {
    expect(filterNumericInput('12x.5')).toBe('12.5')
    expect(filterNumericInput('abc')).toBe('')
    expect(filterNumericInput('−5')).toBe('5') // U+2212, not a hyphen
  })

  it('drops whitespace, including inside', () => {
    expect(filterNumericInput('  -12.5  ')).toBe('-12.5')
    expect(filterNumericInput('1 2')).toBe('12')
  })

  it('returns empty for empty', () => {
    expect(filterNumericInput('')).toBe('')
  })
})

describe('normalizeNumericOnBlur', () => {
  it('keeps a negative value', () => {
    // The regression this guards: it used to strip the sign when the range said so, silently
    // turning −5 into 5 the moment the operator left the field.
    expect(normalizeNumericOnBlur('-5')).toBe('-5')
    expect(normalizeNumericOnBlur('-0.25')).toBe('-0.25')
  })

  it('clears the states that are not values', () => {
    expect(normalizeNumericOnBlur('-')).toBe('')
    expect(normalizeNumericOnBlur('.')).toBe('')
    expect(normalizeNumericOnBlur('-.')).toBe('')
    expect(normalizeNumericOnBlur('')).toBe('')
    expect(normalizeNumericOnBlur('   ')).toBe('')
  })

  it('drops a trailing point', () => {
    expect(normalizeNumericOnBlur('12.')).toBe('12')
    expect(normalizeNumericOnBlur('-12.')).toBe('-12')
  })

  it('leaves a finished number alone', () => {
    expect(normalizeNumericOnBlur('0')).toBe('0')
    expect(normalizeNumericOnBlur('12.5')).toBe('12.5')
  })
})

describe('toggleNumericSign — the ± button', () => {
  it('flips a positive to negative and back', () => {
    expect(toggleNumericSign('5')).toBe('-5')
    expect(toggleNumericSign('-5')).toBe('5')
  })

  it('flips decimals and zero', () => {
    expect(toggleNumericSign('0.25')).toBe('-0.25')
    expect(toggleNumericSign('-0.25')).toBe('0.25')
    expect(toggleNumericSign('0')).toBe('-0')
    expect(toggleNumericSign(0)).toBe('-0')
  })

  it('primes an empty field with a minus, so ± then digits works', () => {
    // Pressing ± before typing is the natural order on a keypad with no minus key.
    expect(toggleNumericSign('')).toBe('-')
    expect(toggleNumericSign(undefined)).toBe('-')
    expect(toggleNumericSign(null)).toBe('-')
    expect(toggleNumericSign('-')).toBe('')
  })

  it('accepts a number as well as a string', () => {
    expect(toggleNumericSign(12.5)).toBe('-12.5')
    expect(toggleNumericSign(-12.5)).toBe('12.5')
  })

  it('round-trips back to the original', () => {
    for (const v of ['5', '-5', '0.1', '-0.1', '0', '']) {
      expect(toggleNumericSign(toggleNumericSign(v))).toBe(v)
    }
  })

  it('produces something the input filter accepts', () => {
    // The two must agree, or the button would write a value the field then refuses.
    for (const v of ['5', '-5', '0.25', '', '-']) {
      const toggled = toggleNumericSign(v)
      expect(filterNumericInput(toggled)).toBe(toggled)
    }
  })
})

describe('formatNumericDisplay', () => {
  it('shows a stored number, including a negative one', () => {
    expect(formatNumericDisplay(-12.5)).toBe('-12.5')
    expect(formatNumericDisplay(0)).toBe('0')
  })

  it('shows nothing for an absent or unusable value', () => {
    expect(formatNumericDisplay(undefined)).toBe('')
    expect(formatNumericDisplay(null)).toBe('')
    expect(formatNumericDisplay(NaN)).toBe('')
    expect(formatNumericDisplay(Infinity)).toBe('')
  })
})

describe('typing a negative reading end to end', () => {
  it('survives filter, blur, storage and judgement', () => {
    // The journey a real reading takes: ± on an empty field, digits, blur, then severity.
    let value = toggleNumericSign('')
    expect(value).toBe('-')

    for (const key of ['1', '2', '.', '5']) {
      value = filterNumericInput(value + key)
    }
    expect(value).toBe('-12.5')

    value = normalizeNumericOnBlur(value)
    expect(value).toBe('-12.5')

    expect(Number(value)).toBe(-12.5)
    expect(evaluateNumericSeverity(value, ranges([-20, -5], [-30, 0]))).toBe('ok')
    expect(evaluateNumericSeverity(value, ranges([10, 20], [5, 25]))).toBe('danger')
  })

  it('an abandoned minus leaves the field empty rather than storing a sign', () => {
    const value = normalizeNumericOnBlur(filterNumericInput('-'))
    expect(value).toBe('')
    expect(evaluateNumericSeverity(value, ranges([10, 20]))).toBe('ok')
  })
})
