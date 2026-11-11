import { describe, it, expect } from 'vitest'
import {
  evaluateFieldSeverity,
  gateHolds,
  hasStateCondition,
  stateConditionSummaryFa,
  stateConditions,
  thresholdsFor,
  validationSummaryFa
} from './fieldValidation'
import { sheetFieldDefinitions } from './sheetFieldDefinitions'
import type { FieldDefinition, FieldValidation } from '@/types/sync'

/**
 * State conditions — a threshold that applies only while another answer says so.
 *
 * This file is the device half of the server's `FieldStateConditionTest`, and it exists because
 * the two halves judge the same reading at different moments: this app paints it the instant it
 * is typed, the server stamps `max_severity` when it arrives. Any disagreement surfaces as the
 * tablet calling a reading red that the exception report calls clean, which reads to everybody
 * as a bug in the report.
 *
 * The first group matters most: every field on every tablet in service has no `conditions` key,
 * and the gate has to be invisible to all of them.
 */

const NO_LOAD = 4.5

/** «The current band applies only while the status says running.» */
function gatedNoLoadBand(): FieldValidation {
  return {
    danger: { min: NO_LOAD, max: 34.8 },
    conditions: [{ when: { field: 'status', op: 'in', values: ['روشن'] } }]
  }
}

describe('a field with no condition is judged exactly as before', () => {
  it('a danger minimum of ZERO still never fires — the interval is closed', () => {
    // Kept as an assertion rather than a comment. `0 < 0` is false, so a reading of zero is
    // INSIDE the band; this is the mistake the whole feature exists to replace, and anybody
    // "fixing" the interval would silently re-judge every stored reading sitting on a bound.
    const v: FieldValidation = { danger: { min: 0 } }
    expect(evaluateFieldSeverity('number', 0, v)).toBe('ok')
    expect(evaluateFieldSeverity('number', -1, v)).toBe('danger')
  })

  it('an ungated band ignores the siblings entirely', () => {
    const v: FieldValidation = { danger: { min: NO_LOAD } }
    expect(evaluateFieldSeverity('number', 0, v)).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 27.4, v, { status: 'روشن' })).toBe('ok')
  })

  it('thresholdsFor hands back the same object, so nothing is copied per keystroke', () => {
    const v: FieldValidation = { warning: { min: 20, max: 80 } }
    expect(thresholdsFor(v, { status: 'روشن' })).toBe(v)
    expect(hasStateCondition(v)).toBe(false)
  })

  it('an ungated summary is what it always was', () => {
    expect(validationSummaryFa({ warning: { min: 20, max: 80 }, danger: { min: 10, max: 90 } }))
      .toBe('هشدار: 20–80 · خطر: 10–90')
  })
})

describe('the gate decides whether the thresholds are judged at all', () => {
  it('ON with no current is a danger; OFF with no current is not judged', () => {
    const v = gatedNoLoadBand()
    expect(evaluateFieldSeverity('number', 0, v, { status: 'روشن', ampere: 0 })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش', ampere: 0 })).toBe('ok')
    expect(evaluateFieldSeverity('number', 27.4, v, { status: 'روشن', ampere: 27.4 })).toBe('ok')
  })

  it('an unanswered gate parameter does not hold', () => {
    const v = gatedNoLoadBand()
    expect(evaluateFieldSeverity('number', 0, v, { ampere: 0 })).toBe('ok')
    expect(evaluateFieldSeverity('number', 0, v, { status: null, ampere: 0 })).toBe('ok')
    // A blank string is ABSENT, not an answer of "" — the server's isAnswered agrees, and so
    // does the alarm history, which counts it as «not read».
    expect(evaluateFieldSeverity('number', 0, v, { status: '   ' })).toBe('ok')
  })

  it('without the siblings a gated field is suppressed, never alerted', () => {
    const v = gatedNoLoadBand()
    expect(evaluateFieldSeverity('number', 0, v)).toBe('ok')
    expect(evaluateFieldSeverity('number', 0, v, null)).toBe('ok')
  })

  it('the sibling KEY is case-insensitive and the compared VALUES are not', () => {
    const v = gatedNoLoadBand()
    expect(evaluateFieldSeverity('number', 0, v, { STATUS: 'روشن' })).toBe('danger')

    const english: FieldValidation = {
      danger: { min: NO_LOAD },
      conditions: [{ when: { field: 'state', op: 'in', values: ['ON'] } }]
    }
    expect(evaluateFieldSeverity('number', 0, english, { state: 'ON' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, english, { state: 'on' })).toBe('ok')
    expect(evaluateFieldSeverity('number', 0, english, { state: '  ON  ' })).toBe('danger')
  })

  it('the mirror fault lives on the STATUS field: stopped but drawing current', () => {
    const v: FieldValidation = {
      conditions: [
        { when: { field: 'ampere', op: 'gte', value: NO_LOAD }, dangerOptions: ['خاموش'] }
      ]
    }
    expect(evaluateFieldSeverity('select', 'خاموش', v, { status: 'خاموش', ampere: 18 }))
      .toBe('danger')
    expect(evaluateFieldSeverity('select', 'خاموش', v, { status: 'خاموش', ampere: 0 })).toBe('ok')
    expect(evaluateFieldSeverity('select', 'روشن', v, { status: 'روشن', ampere: 18 })).toBe('ok')
  })

  it('a multiselect gate holds when ANY chosen option matches', () => {
    const v: FieldValidation = {
      danger: { min: NO_LOAD },
      conditions: [{ when: { field: 'modes', op: 'in', values: ['RUN'] } }]
    }
    expect(evaluateFieldSeverity('number', 0, v, { modes: ['LOCAL', 'RUN'] })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { modes: ['LOCAL'] })).toBe('ok')
    expect(evaluateFieldSeverity('number', 0, v, { modes: [] })).toBe('ok')
  })

  it('notIn is the negation over every chosen option', () => {
    const gate = { field: 'modes', op: 'notIn' as const, values: ['RUN'] }
    expect(gateHolds(gate, { modes: ['LOCAL'] })).toBe(true)
    expect(gateHolds(gate, { modes: ['LOCAL', 'RUN'] })).toBe(false)
  })

  it('notIn still needs an answer, which reads as the opposite of what it says', () => {
    // «judge the current unless the status says off» — the fail-safe way to write it: a state
    // added to the vocabulary later keeps being judged, where `in ['روشن']` would silently stop.
    const v: FieldValidation = {
      warning: { min: 20.3, max: 31.9 },
      danger: { min: NO_LOAD, max: 34.8 },
      conditions: [{ when: { field: 'status', op: 'notIn', values: ['خاموش'] } }]
    }
    expect(evaluateFieldSeverity('number', 0, v, { status: 'روشن' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { status: 'راه‌اندازی' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش' })).toBe('ok')
    // ANY value, not just the low ones.
    expect(evaluateFieldSeverity('number', 40, v, { status: 'خاموش' })).toBe('ok')
    // And the edge: «the status is NOT off» sounds true of a round where nobody answered the
    // status. It is not — every operator but `notAnswered` needs an answer. Close that gap with
    // `required` on the gate's parameter, never with a looser gate.
    expect(evaluateFieldSeverity('number', 0, v, { ampere: 0 })).toBe('ok')
    expect(evaluateFieldSeverity('number', 0, v, { status: '  ' })).toBe('ok')
  })

  it('answered / notAnswered ask only whether the sibling was filled in', () => {
    expect(gateHolds({ field: 'status', op: 'answered' }, { status: 'خاموش' })).toBe(true)
    expect(gateHolds({ field: 'status', op: 'answered' }, { other: 1 })).toBe(false)
    expect(gateHolds({ field: 'status', op: 'notAnswered' }, { other: 1 })).toBe(true)
    expect(gateHolds({ field: 'status', op: 'notAnswered' }, { status: 'خاموش' })).toBe(false)
  })

  it('every numeric comparison, at and around its bound', () => {
    expect(gateHolds({ field: 'p', op: 'gt', value: 10 }, { p: 10 })).toBe(false)
    expect(gateHolds({ field: 'p', op: 'gt', value: 10 }, { p: 10.1 })).toBe(true)
    expect(gateHolds({ field: 'p', op: 'gte', value: 10 }, { p: 10 })).toBe(true)
    expect(gateHolds({ field: 'p', op: 'lt', value: 10 }, { p: 10 })).toBe(false)
    expect(gateHolds({ field: 'p', op: 'lte', value: 10 }, { p: 10 })).toBe(true)
    expect(gateHolds({ field: 'p', op: 'gte', value: 10 }, { p: '12' })).toBe(true)
    expect(gateHolds({ field: 'p', op: 'gte', value: 10 }, { p: 'n/a' })).toBe(false)
    // A bound sent as a string survives JSON round trips through older writers.
    expect(gateHolds({ field: 'p', op: 'gte', value: '10' }, { p: 12 })).toBe(true)
  })

  it('a condition that declares its own bands states them completely', () => {
    const v: FieldValidation = {
      warning: { min: 20, max: 32 },
      danger: { min: NO_LOAD, max: 34.8 },
      conditions: [
        { when: { field: 'status', op: 'in', values: ['خاموش'] }, danger: { max: 0.05 } }
      ]
    }
    expect(evaluateFieldSeverity('number', 18, v, { status: 'خاموش' })).toBe('danger')
    // The running state's warning band is NOT inherited into the stopped state.
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش' })).toBe('ok')
  })

  it('the vocabulary survives a condition that re-marks its options', () => {
    const v: FieldValidation = {
      options: [{ value: 'A', label: 'A' }],
      conditions: [{ when: { field: 'mode', op: 'in', values: ['X'] }, dangerOptions: ['B'] }]
    }
    const thresholds = thresholdsFor(v, { mode: 'X' }) as Record<string, unknown>
    expect(thresholds.options).toEqual([{ value: 'A', label: 'A' }])
    expect(thresholds.conditions).toBeUndefined()
  })

  it('the first matching condition wins, in stored order', () => {
    const v: FieldValidation = {
      conditions: [
        { when: { field: 'status', op: 'in', values: ['روشن'] }, danger: { min: NO_LOAD } },
        { when: { field: 'status', op: 'answered' }, danger: { min: 1000 } }
      ]
    }
    expect(evaluateFieldSeverity('number', 100, v, { status: 'روشن' })).toBe('ok')
    expect(evaluateFieldSeverity('number', 100, v, { status: 'خاموش' })).toBe('danger')
  })
})

describe('anything unreadable suppresses, and nothing throws', () => {
  it('an unknown operator never matches', () => {
    const v: FieldValidation = {
      danger: { min: NO_LOAD },
      conditions: [{ when: { field: 'status', op: 'approximately', values: ['روشن'] } }]
    }
    expect(evaluateFieldSeverity('number', 0, v, { status: 'روشن' })).toBe('ok')
  })

  it('a conditions key that is not a list reads as «no conditions»', () => {
    // Restoring the pre-gate behaviour — a band that works — beats suppressing a danger band
    // because a hand edit put a string where a list belongs.
    const v = { danger: { min: NO_LOAD }, conditions: 'when it is on' } as unknown as FieldValidation
    expect(stateConditions(v)).toEqual([])
    expect(evaluateFieldSeverity('number', 0, v, { status: 'روشن' })).toBe('danger')
  })

  it('a condition with no readable gate suppresses rather than applying its bands', () => {
    const v: FieldValidation = { conditions: [{ danger: { min: NO_LOAD } }] }
    expect(evaluateFieldSeverity('number', 0, v, { status: 'روشن' })).toBe('ok')
    expect(validationSummaryFa(v)).toContain('نامعتبر')
  })

  it('a gate with a missing operand never matches', () => {
    expect(gateHolds({ field: 'status', op: 'in', values: [] }, { status: 'روشن' })).toBe(false)
    expect(gateHolds({ field: 'status', op: 'gte' }, { status: 5 })).toBe(false)
    expect(gateHolds({ op: 'answered' }, { status: 5 })).toBe(false)
  })

  it('null and undefined are answers, not exceptions', () => {
    expect(evaluateFieldSeverity('number', 0, undefined, {})).toBe('ok')
    expect(stateConditions(undefined)).toEqual([])
    expect(hasStateCondition(undefined)).toBe(false)
    expect(gateHolds(undefined, {})).toBe(false)
    expect(gateHolds({ field: 'a', op: 'in', values: ['x'] }, undefined)).toBe(false)
    expect(stateConditionSummaryFa(undefined)).toBeNull()
  })
})

describe('the summary says WHEN, not only how much', () => {
  it('the gate is part of the one line the operator gets', () => {
    const summary = validationSummaryFa(gatedNoLoadBand())
    expect(summary).toContain('فقط وقتی')
    expect(summary).toContain('status')
    expect(summary).toContain('روشن')
    expect(summary).toContain('4.5')
  })

  it('a choice field gets the condition on its own, beside its option list', () => {
    expect(stateConditionSummaryFa({
      conditions: [{ when: { field: 'ampere', op: 'gte', value: 4.5 } }]
    })).toBe('فقط وقتی ampere بیشتر یا مساوی 4.5')
  })
})

describe('the per-asset layer carries the condition', () => {
  const classField: FieldDefinition = {
    id: 'fd-1',
    classId: 'c-1',
    key: 'ampere',
    label: 'جریان',
    dataType: 'number',
    required: false,
    order: 0,
    validation: gatedNoLoadBand(),
    updatedAt: 0,
    syncStatus: 'synced'
  } as unknown as FieldDefinition

  /** The resolved `ampere` definition for asset `a-1`, with this override frozen onto the sheet. */
  function resolved(override: Record<string, unknown>): FieldValidation | undefined {
    const sheet = {
      fieldDefinitions: [classField],
      fieldOverridesSnapshot: { 'a-1': { source: 'RANGES_ONLY', fields: { ampere: override } } }
    } as unknown as Parameters<typeof sheetFieldDefinitions>[0]
    const fields = sheetFieldDefinitions(sheet, 'c-1', [], 'a-1')
    return fields.find(fd => fd.key === 'ampere')?.validation
  }

  it("a band-only override keeps the class's gate", () => {
    const v = resolved({ danger: { min: 6 } })
    expect(hasStateCondition(v)).toBe(true)
    expect(evaluateFieldSeverity('number', 5, v, { status: 'روشن' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 5, v, { status: 'خاموش' })).toBe('ok')
  })

  it("an explicit null drops the class's gate for this machine", () => {
    const v = resolved({ conditions: null })
    expect(hasStateCondition(v)).toBe(false)
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش' })).toBe('danger')
  })

  it('an asset may replace the condition outright', () => {
    const v = resolved({
      conditions: [{ when: { field: 'status', op: 'notIn', values: ['خاموش'] } }]
    })
    expect(evaluateFieldSeverity('number', 0, v, { status: 'راه‌اندازی' })).toBe('danger')
    expect(evaluateFieldSeverity('number', 0, v, { status: 'خاموش' })).toBe('ok')
  })
})
