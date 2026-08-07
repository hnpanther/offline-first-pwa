import { describe, expect, it } from 'vitest'
import { buildValidationRules } from '@/components/forms/DynamicClassForm'
import { buildAttachmentRef } from '@/services/storage/attachments'
import type { FieldDefinition } from '@/types/sync'

/**
 * Required-ness for a media field cannot go through react-hook-form's `required`.
 *
 * Once the capture control has rendered, the field's value is an object — `{type:'attachment',
 * ids:[]}` — and every object is truthy. `required` would therefore pass for a photo field
 * nobody photographed, and the sheet would submit with the evidence missing. The rule below
 * counts ids instead.
 */

function field(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: '1',
    classId: '2',
    key: 'pump_photo',
    label: 'عکس پمپ',
    dataType: 'image',
    required: true,
    order: 1,
    ...overrides
  } as FieldDefinition
}

function runValidate(def: FieldDefinition, value: unknown) {
  const rules = buildValidationRules(def)
  const validate = rules.validate as ((v: unknown) => true | string) | undefined
  return validate ? validate(value) : true
}

describe('buildValidationRules for a media field', () => {
  it('rejects an empty reference object, which a truthiness check would accept', () => {
    expect(runValidate(field(), buildAttachmentRef([]))).toBe('این فیلد الزامی است')
  })

  it('rejects a field never touched at all', () => {
    expect(runValidate(field(), undefined)).toBe('این فیلد الزامی است')
  })

  it('accepts a field with a captured file', () => {
    expect(runValidate(field(), buildAttachmentRef(['abc']))).toBe(true)
  })

  it('rejects a reference holding only blank ids', () => {
    expect(runValidate(field(), { type: 'attachment', ids: ['', null] })).toBe(
      'این فیلد الزامی است'
    )
  })

  it('applies no rules at all to an optional media field', () => {
    // Notably no `required: false` key either: the whole react-hook-form rule set is skipped,
    // so nothing can accidentally validate a reference object as if it were text.
    expect(buildValidationRules(field({ required: false }))).toEqual({})
  })

  it('uses the same rule for audio and video fields', () => {
    for (const dataType of ['audio', 'video']) {
      expect(runValidate(field({ dataType }), buildAttachmentRef([]))).toBe('این فیلد الزامی است')
      expect(runValidate(field({ dataType }), buildAttachmentRef(['a']))).toBe(true)
    }
  })

  it('leaves ordinary fields on the standard rules', () => {
    const rules = buildValidationRules(
      field({ dataType: 'text', required: true, validation: { maxLength: 10 } } as Partial<FieldDefinition>)
    )
    expect(rules.required).toBe('این فیلد الزامی است')
    expect(rules.validate).toBeUndefined()
    expect(rules.maxLength).toMatchObject({ value: 10 })
  })
})
