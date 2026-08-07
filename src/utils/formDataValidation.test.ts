import { describe, expect, it } from 'vitest'
import {
  describeSubmitBlockingIssues,
  findSubmitBlockingIssues,
  hasMeaningfulFormData,
  isFieldValueBlank
} from '@/utils/formDataValidation'
import type { FieldDefinition } from '@/types/sync'
import type { LogSheet, LogSheetEntryData } from '@/types'

/**
 * This module exists to stop an operator submitting a sheet the server is certain to reject.
 * It only works if its idea of "blank" matches the server's exactly, so most of what follows
 * is that correspondence — each case mirrors a branch of `FormDataValidationSupport.isBlank`.
 *
 * The asymmetry to keep in mind while reading: a **false block** is the dangerous failure. It
 * strands an operator with no error from anyone and no way forward, which is worse than the
 * dead end this replaces. A missed block merely returns to the old behaviour — the server
 * rejects and the correction path opens.
 */

function def(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: '1',
    classId: '2',
    key: 'temp',
    label: 'دما',
    dataType: 'number',
    required: true,
    order: 1,
    deleted: false,
    ...overrides
  } as FieldDefinition
}

function entry(overrides: Partial<LogSheetEntryData> = {}): LogSheetEntryData {
  return {
    assetId: '7',
    assetName: 'پمپ ۱',
    classId: '2',
    formData: {},
    ...overrides
  } as LogSheetEntryData
}

function sheet(entries: LogSheetEntryData[], defs: FieldDefinition[]): LogSheet {
  return { entries, fieldDefinitions: defs } as LogSheet
}

describe('isFieldValueBlank — the server correspondence', () => {
  it('treats null, undefined and an empty/whitespace string as blank', () => {
    expect(isFieldValueBlank(undefined, 'text')).toBe(true)
    expect(isFieldValueBlank(null, 'text')).toBe(true)
    expect(isFieldValueBlank('', 'text')).toBe(true)
    expect(isFieldValueBlank('   ', 'text')).toBe(true)
    expect(isFieldValueBlank('42', 'text')).toBe(false)
  })

  it('treats an empty array as blank and a populated one as answered', () => {
    expect(isFieldValueBlank([], 'multiselect')).toBe(true)
    expect(isFieldValueBlank(['ON'], 'multiselect')).toBe(false)
  })

  it('treats an unchecked checkbox as blank — the case the old helper got wrong', () => {
    // `evaluateEntryCompletion`'s isValueFilled returns true for `false`, so a required
    // unchecked checkbox looked complete on the device and was rejected on arrival. That is
    // precisely the dead end this gate exists to prevent, so it is pinned down here.
    // The app stores a real boolean (a MUI switch), so this is the shape that matters.
    expect(isFieldValueBlank(false, 'checkbox')).toBe(true)
    expect(isFieldValueBlank(true, 'checkbox')).toBe(false)
  })

  it('matches the server even where the server is surprising: "false" as text is not blank', () => {
    // Faithfulness beats intuition here. `FormDataValidationSupport.isBlank` tests `instanceof
    // String` *before* it reaches the checkbox branch, so a non-empty string is never blank and
    // the checkbox's own "false"/"0" handling is only reachable for non-string values. The web
    // form posts strings, the app posts booleans — mirroring the quirk keeps this gate from
    // blocking a submission the server would have taken.
    expect(isFieldValueBlank('false', 'checkbox')).toBe(false)
    expect(isFieldValueBlank('0', 'checkbox')).toBe(false)
    expect(isFieldValueBlank(0, 'checkbox')).toBe(true)
  })

  it('treats a media field with no ids as blank, however it is shaped', () => {
    // What is left after the operator captures a photo and then deletes it.
    expect(isFieldValueBlank({ type: 'attachment', ids: [] }, 'image')).toBe(true)
    expect(isFieldValueBlank({ type: 'attachment', ids: ['a7f3'] }, 'image')).toBe(false)
    expect(isFieldValueBlank({ type: 'attachment', ids: ['', null] }, 'audio')).toBe(true)
    expect(isFieldValueBlank({ type: 'attachment', ids: ['x'] }, 'video')).toBe(false)
  })

  it('treats a location as blank unless it holds a real coordinate', () => {
    expect(isFieldValueBlank({ type: 'location' }, 'location')).toBe(true)
    expect(isFieldValueBlank({ type: 'location', lat: 35.6892, lng: 51.389 }, 'location')).toBe(false)
    expect(isFieldValueBlank('35.6892,51.3890', 'location')).toBe(false)
    // Out of WGS-84 bounds is corruption, not a place — the server refuses it too.
    expect(isFieldValueBlank({ lat: 999, lng: 51 }, 'location')).toBe(true)
    expect(isFieldValueBlank({ lat: 35.6, lng: 'abc' }, 'location')).toBe(true)
  })

  it('treats any other non-empty scalar as answered', () => {
    expect(isFieldValueBlank(0, 'number')).toBe(false)
    expect(isFieldValueBlank(42, 'number')).toBe(false)
  })

  it('does not treat zero as blank', () => {
    // A pressure of 0 is a reading, not a missing answer. Blocking it would refuse a correct
    // submission — the exact failure this gate must never produce.
    expect(isFieldValueBlank(0, 'number')).toBe(false)
  })
})

describe('hasMeaningfulFormData', () => {
  it('is false for an entry nobody touched', () => {
    expect(hasMeaningfulFormData(undefined)).toBe(false)
    expect(hasMeaningfulFormData({})).toBe(false)
    expect(hasMeaningfulFormData({ temp: null, note: '  ' })).toBe(false)
    expect(hasMeaningfulFormData({ tags: [] })).toBe(false)
  })

  it('is true as soon as anything was entered', () => {
    expect(hasMeaningfulFormData({ temp: 42 })).toBe(true)
    expect(hasMeaningfulFormData({ note: 'ok' })).toBe(true)
    expect(hasMeaningfulFormData({ done: false })).toBe(true)
  })
})

describe('findSubmitBlockingIssues', () => {
  it('reports a required field left empty on a touched entry', () => {
    const issues = findSubmitBlockingIssues(
      sheet([entry({ formData: { note: 'started' } })], [def(), def({ key: 'note', required: false })])
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].fieldLabel).toBe('دما')
    expect(issues[0].assetName).toBe('پمپ ۱')
  })

  it('ignores an entry the operator never touched', () => {
    // A multi-asset sheet legitimately has assets nobody reached; the server skips them too.
    // Blocking here would make every partially-filled sheet unsubmittable.
    expect(findSubmitBlockingIssues(sheet([entry()], [def()]))).toEqual([])
  })

  it('accepts a fully answered entry', () => {
    expect(
      findSubmitBlockingIssues(sheet([entry({ formData: { temp: 42 } })], [def()]))
    ).toEqual([])
  })

  it('ignores optional fields', () => {
    expect(
      findSubmitBlockingIssues(
        sheet([entry({ formData: { note: 'x' } })], [def({ required: false }), def({ key: 'note', required: false })])
      )
    ).toEqual([])
  })

  it('ignores a deleted field definition', () => {
    expect(
      findSubmitBlockingIssues(
        sheet([entry({ formData: { note: 'x' } })], [def({ deleted: true }), def({ key: 'note', required: false })])
      )
    ).toEqual([])
  })

  it('allows the submit when this device has no schema for the class', () => {
    // The server validates against its own frozen snapshot and may well accept it. Blocking
    // over data the *device* is missing would strand the operator for no reason.
    expect(
      findSubmitBlockingIssues(sheet([entry({ formData: { temp: 42 } })], []))
    ).toEqual([])
  })

  it('ignores definitions belonging to a different class', () => {
    expect(
      findSubmitBlockingIssues(
        sheet([entry({ classId: '2', formData: { note: 'x' } })], [def({ classId: '99' })])
      )
    ).toEqual([])
  })

  it('catches the unchecked required checkbox end to end', () => {
    const issues = findSubmitBlockingIssues(
      sheet(
        [entry({ formData: { approved: false, note: 'x' } })],
        [def({ key: 'approved', label: 'تأیید شد', dataType: 'checkbox' })]
      )
    )
    expect(issues.map(i => i.fieldLabel)).toEqual(['تأیید شد'])
  })

  it('catches a required photo field whose only image was deleted', () => {
    const issues = findSubmitBlockingIssues(
      sheet(
        [entry({ formData: { pump_photo: { type: 'attachment', ids: [] }, note: 'x' } })],
        [def({ key: 'pump_photo', label: 'عکس پمپ', dataType: 'image' })]
      )
    )
    expect(issues.map(i => i.fieldLabel)).toEqual(['عکس پمپ'])
  })

  it('collects issues across several assets', () => {
    const issues = findSubmitBlockingIssues(
      sheet(
        [
          entry({ assetId: '1', assetName: 'پمپ ۱', formData: { note: 'x' } }),
          entry({ assetId: '2', assetName: 'پمپ ۲', formData: { temp: 10 } }),
          entry({ assetId: '3', assetName: 'پمپ ۳', formData: { note: 'y' } })
        ],
        [def(), def({ key: 'note', required: false })]
      )
    )
    expect(issues.map(i => i.assetName)).toEqual(['پمپ ۱', 'پمپ ۳'])
  })
})

describe('describeSubmitBlockingIssues', () => {
  it('names the offending assets and fields', () => {
    const text = describeSubmitBlockingIssues([
      { assetId: '1', assetName: 'پمپ ۱', fieldLabel: 'دما' }
    ])
    expect(text).toContain('پمپ ۱')
    expect(text).toContain('دما')
  })

  it('summarises rather than listing a whole sheet', () => {
    // A 50-asset sheet must not produce a wall of text on a phone screen.
    const many = Array.from({ length: 7 }, (_, i) => ({
      assetId: String(i),
      assetName: `پمپ ${i}`,
      fieldLabel: 'دما'
    }))
    const text = describeSubmitBlockingIssues(many)
    expect(text).toContain('۴'.replace('۴', '4')) // "و 4 مورد دیگر"
    expect(text.split('،').length).toBeLessThanOrEqual(4)
  })

  it('is empty when nothing is wrong', () => {
    expect(describeSubmitBlockingIssues([])).toBe('')
  })
})
