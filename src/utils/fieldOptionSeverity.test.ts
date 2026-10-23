import { describe, it, expect } from 'vitest'
import {
  evaluateFieldSeverity,
  evaluateOptionSeverity,
  isChoiceType,
  optionSeverityMessage,
  optionSeveritySummaryFa,
  supportsSeverity
} from '@/utils/fieldValidation'
import type { FieldValidation } from '@/types/sync'

/**
 * Which CHOICES are the alert.
 *
 * The polarity is the opposite of a numeric band — `warning` is a range a reading must stay
 * inside, `warningOptions` are the options that ARE the warning — so every case here asserts
 * that direction. Reading it the other way round inverts every alert on a plant.
 *
 * These must agree with the backend's `FieldValidationSupport.evaluateOptionValue` exactly. The
 * server recomputes `max_severity` from its own copy on every write, so a looser rule here does
 * not corrupt data; it tells an operator a reading is fine that comes back as a danger, which is
 * the version of wrong that costs a second trip to the equipment.
 */

const vocabulary: FieldValidation = {
  options: [
    { value: 'OF', label: 'OF' },
    { value: 'ON', label: 'ON' },
    { value: 'Idle', label: 'Idle' }
  ],
  warningOptions: ['Idle'],
  dangerOptions: ['OF']
}

describe('option severity', () => {
  it('gives a chosen option its own severity', () => {
    expect(evaluateOptionSeverity('OF', vocabulary)).toBe('danger')
    expect(evaluateOptionSeverity('Idle', vocabulary)).toBe('warning')
    expect(evaluateOptionSeverity('ON', vocabulary)).toBe('ok')
  })

  it('treats an unknown or empty choice as no alert', () => {
    expect(evaluateOptionSeverity('Maintenance', vocabulary)).toBe('ok')
    expect(evaluateOptionSeverity(null, vocabulary)).toBe('ok')
    expect(evaluateOptionSeverity(undefined, vocabulary)).toBe('ok')
    expect(evaluateOptionSeverity('', vocabulary)).toBe('ok')
  })

  it('takes the worst of a multiselect, so one bad tick is a danger', () => {
    expect(evaluateOptionSeverity(['ON', 'Idle'], vocabulary)).toBe('warning')
    expect(evaluateOptionSeverity(['ON', 'Idle', 'OF'], vocabulary)).toBe('danger')
    expect(evaluateOptionSeverity(['ON'], vocabulary)).toBe('ok')
    expect(evaluateOptionSeverity([], vocabulary)).toBe('ok')
  })

  it('trims but is case-sensitive, matching the submit-time allow-list', () => {
    expect(evaluateOptionSeverity('  OF  ', vocabulary)).toBe('danger')
    expect(evaluateOptionSeverity('of', vocabulary)).toBe('ok')
  })

  it('never alerts on a field that names no severities', () => {
    const plain: FieldValidation = { options: vocabulary.options }
    expect(evaluateOptionSeverity('OF', plain)).toBe('ok')
    expect(evaluateOptionSeverity('OF', undefined)).toBe('ok')
  })

  it('dispatches by type, and a type with no notion of severity is ok', () => {
    expect(evaluateFieldSeverity('select', 'OF', vocabulary)).toBe('danger')
    expect(evaluateFieldSeverity('multiselect', ['OF'], vocabulary)).toBe('danger')
    // The same stored map on a text field: a note is not in or out of range.
    expect(evaluateFieldSeverity('text', 'OF', vocabulary)).toBe('ok')
    expect(evaluateFieldSeverity('image', 'OF', vocabulary)).toBe('ok')
    expect(evaluateFieldSeverity(undefined, 'OF', vocabulary)).toBe('ok')
  })

  it('still evaluates a number by its range', () => {
    const band: FieldValidation = { warning: { min: 0, max: 10 } }
    expect(evaluateFieldSeverity('number', 12, band)).toBe('warning')
    expect(evaluateFieldSeverity('number', 5, band)).toBe('ok')
  })

  it('words a chosen option differently from a range breach', () => {
    expect(optionSeverityMessage('danger')).toContain('خطر')
    expect(optionSeverityMessage('warning')).toContain('هشدار')
    expect(optionSeverityMessage('ok')).toBeNull()
  })

  it('summarises which options alert, for the hint shown before anything is chosen', () => {
    const summary = optionSeveritySummaryFa(vocabulary)
    expect(summary).toContain('Idle')
    expect(summary).toContain('OF')
    expect(optionSeveritySummaryFa({ options: vocabulary.options })).toBeNull()
  })

  it('reads a vocabulary stored as plain strings, which is what the server sends', () => {
    // The server stores `options` as a list of strings; only this app ever uses {value,label}.
    const asStored = {
      options: ['OF', 'ON', 'Idle'],
      dangerOptions: ['OF']
    } as unknown as FieldValidation
    expect(evaluateOptionSeverity('OF', asStored)).toBe('danger')
  })
})

/**
 * The gate that decides whether a field is given its thresholds at all.
 *
 * This is the bug that made option severity look broken in the app: the form passed
 * `validation` down only when `dataType === 'number'`, so a select received none and nothing
 * coloured while the operator was choosing. The severity appeared only after saving and
 * reopening — a different path (the read-only review) that reads `def.validation` directly.
 *
 * Two type lists, one of them narrower. The fix is one exported predicate, and this is the test
 * that fails if a third list ever appears.
 */
describe('supportsSeverity', () => {
  it('covers exactly the types that evaluateFieldSeverity can judge', () => {
    const everyType = [
      'number', 'text', 'select', 'multiselect', 'checkbox',
      'textarea', 'image', 'audio', 'video', 'location'
    ]
    // A validation object carrying BOTH kinds of threshold, so the only thing that can make a
    // type answer 'ok' is the type itself.
    const bothKinds = {
      warning: { min: 0, max: 1 },
      danger: { min: 0, max: 1 },
      options: ['OF'],
      dangerOptions: ['OF']
    }

    for (const type of everyType) {
      const judged = evaluateFieldSeverity(type, type === 'number' ? 99 : 'OF', bothKinds) !== 'ok'
      expect(judged).toBe(supportsSeverity(type))
    }
  })

  it('names the two choice types and nothing else', () => {
    expect(isChoiceType('select')).toBe(true)
    expect(isChoiceType('multiselect')).toBe(true)
    expect(isChoiceType('number')).toBe(false)
    expect(isChoiceType(undefined)).toBe(false)
    expect(supportsSeverity('number')).toBe(true)
    expect(supportsSeverity('text')).toBe(false)
    expect(supportsSeverity(undefined)).toBe(false)
  })
})
