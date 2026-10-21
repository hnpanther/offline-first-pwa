import { describe, it, expect } from 'vitest'
import { evaluateEntryCompletion } from '@/utils/entryCompletion'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import type { LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'

/**
 * The N-of-M badge, as the fill page composes it.
 *
 * `LogSheetFillPage` resolves a definition list per row and hands it to
 * `evaluateEntryCompletion`. That resolution used to be keyed by CLASS, justified in a comment
 * as "an override changes a band rather than whether a field must be answered" — which holds
 * for RANGES_ONLY and fails for FULL, the mode that exists to add and remove fields.
 *
 * These two cases are the failure that justified keying the map by asset. Each asserts both
 * directions: what the operator sees now, and what the class-keyed resolution reported.
 */

function field(key: string, order: number, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: `7-${key}`,
    classId: '7',
    key,
    label: key,
    dataType: 'number',
    required: true,
    order,
    ...extra
  } as FieldDefinition
}

const CLASS_FIELDS = [field('ampere', 0), field('pressure', 1)]

function sheetWith(overrides: Record<string, unknown>): LogSheet {
  return {
    fieldDefinitions: CLASS_FIELDS,
    fieldOverridesSnapshot: overrides
  } as unknown as LogSheet
}

function entry(assetId: string, formData: Record<string, unknown>): LogSheetEntryData {
  return { assetId, classId: '7', formData } as unknown as LogSheetEntryData
}

describe('the completion badge of an asset that owns its field list', () => {
  it('reaches complete when a FULL asset answered every field it actually has', () => {
    // Pump 11 dropped pressure. Its own schema is one field, and it is answered.
    const sheet = sheetWith({ '11': { source: 'FULL', fields: { pressure: { removed: true } } } })
    const row = entry('11', { ampere: 12 })

    const perAsset = evaluateEntryCompletion(row, sheetFieldDefinitions(sheet, '7', [], '11'))
    expect(perAsset).toMatchObject({ filledCount: 1, totalCount: 1, isComplete: true })

    // Resolved by class, pressure is still required and unanswerable: 1 of 2, never complete.
    const perClass = evaluateEntryCompletion(row, sheetFieldDefinitions(sheet, '7', []))
    expect(perClass).toMatchObject({ filledCount: 1, totalCount: 2, isComplete: false })
  })

  it('counts the field a FULL asset added, even though it is optional', () => {
    // The panel cannot mark a per-asset field required, so an added one is optional and
    // `isComplete` is true either way. The COUNT is the harm: the badge read «2 از 2» with a
    // third field sitting empty on the form below it.
    const sheet = sheetWith({ '12': { source: 'FULL', fields: { vibration: { label: 'لرزش' } } } })
    const row = entry('12', { ampere: 12, pressure: 3 })

    expect(evaluateEntryCompletion(row, sheetFieldDefinitions(sheet, '7', [], '12')))
      .toMatchObject({ filledCount: 2, totalCount: 3 })
    expect(evaluateEntryCompletion(row, sheetFieldDefinitions(sheet, '7', [])))
      .toMatchObject({ filledCount: 2, totalCount: 2 })
  })

  // `required` is not reachable from the panel's form, but the server's override sanitiser
  // allows the key and `AssetFieldResolver.fromOverride` reads it. If it ever arrives, the
  // badge has to agree with the server about whether the round is finishable.
  it('holds the badge back for a required field the override carries', () => {
    const sheet = sheetWith({
      '12': { source: 'FULL', fields: { vibration: { label: 'لرزش', required: true } } }
    })
    const row = entry('12', { ampere: 12, pressure: 3 })

    expect(evaluateEntryCompletion(row, sheetFieldDefinitions(sheet, '7', [], '12')))
      .toMatchObject({ totalCount: 3, requiredCount: 3, isComplete: false })
  })
})
