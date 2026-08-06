import { describe, it, expect } from 'vitest'
import { sheetFieldDefinitions, hasOwnFieldDefinitions } from '@/utils/sheetFieldDefinitions'
import type { LogSheet } from '@/types'
import type { FieldDefinition } from '@/types/sync'

/**
 * The reported bug, as a test.
 *
 * Two open sheets, A and B, both containing assets of class Pump (7). Sheet A was raised when
 * Pump had four fields; Pump was later edited and sheet B carries only three. The server sends
 * each sheet its own frozen snapshot, so the two bundles genuinely differ — and the shared
 * per-class table, holding whichever merged last, cannot represent both.
 *
 * Every case here asks the same question: does sheet A still render sheet A's schema?
 */

function field(key: string, classId: string, order: number, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: `${classId}-${key}`,
    classId,
    key,
    label: key,
    dataType: 'text',
    required: false,
    order,
    ...extra
  } as FieldDefinition
}

// Sheet A's Pump schema — the fuller one, including Remark.
const SHEET_A_PUMP = [
  field('Temperature', '7', 1),
  field('Pressure', '7', 2),
  field('Status', '7', 3),
  field('Remark', '7', 4)
]

// What sheet B's later bundle left in the shared table: Remark is gone.
const SHARED_TABLE_AFTER_B = [
  field('Temperature', '7', 1),
  field('Pressure', '7', 2),
  field('Status', '7', 3)
]

function sheet(fieldDefinitions?: FieldDefinition[]): LogSheet {
  return { localId: 'A', fieldDefinitions } as LogSheet
}

describe('a sheet with its own frozen schema', () => {
  it('keeps its own fields even after another sheet thinned the shared table', () => {
    const fields = sheetFieldDefinitions(sheet(SHEET_A_PUMP), '7', SHARED_TABLE_AFTER_B)

    // Remark is the field sheet B's bundle dropped; sheet A must still offer it.
    expect(fields.map(f => f.key)).toEqual(['Temperature', 'Pressure', 'Status', 'Remark'])
  })

  it('ignores the shared table entirely, even when it holds more fields', () => {
    // The reverse direction matters too: sheet A must not inherit a field it never had.
    const sharedWithExtra = [...SHEET_A_PUMP, field('AddedLater', '7', 5)]
    const fields = sheetFieldDefinitions(sheet(SHARED_TABLE_AFTER_B), '7', sharedWithExtra)

    expect(fields.map(f => f.key)).toEqual(['Temperature', 'Pressure', 'Status'])
  })

  it('returns only the requested class on a multi-class sheet', () => {
    const multiClass = [...SHEET_A_PUMP, field('Voltage', '9', 1), field('Current', '9', 2)]

    expect(sheetFieldDefinitions(sheet(multiClass), '9', []).map(f => f.key))
      .toEqual(['Voltage', 'Current'])
  })

  it('returns nothing — not the fallback — for a class this sheet does not cover', () => {
    // "This sheet has no fields for class 9" is a real answer. Falling back here would show
    // another sheet's schema, which is the very bug being fixed.
    expect(sheetFieldDefinitions(sheet(SHEET_A_PUMP), '9', SHARED_TABLE_AFTER_B)).toEqual([])
  })

  it('sorts by display order regardless of stored order', () => {
    const scrambled = [field('c', '7', 3), field('a', '7', 1), field('b', '7', 2)]

    expect(sheetFieldDefinitions(sheet(scrambled), '7', []).map(f => f.key))
      .toEqual(['a', 'b', 'c'])
  })

  it('drops soft-deleted fields', () => {
    const withDeleted = [...SHEET_A_PUMP, field('Retired', '7', 5, { deleted: true })]

    expect(sheetFieldDefinitions(sheet(withDeleted), '7', []).map(f => f.key))
      .not.toContain('Retired')
  })

  it('matches class ids across string/number representations', () => {
    expect(sheetFieldDefinitions(sheet(SHEET_A_PUMP), 7, []).map(f => f.key))
      .toHaveLength(4)
  })
})

describe('sheets stored before the schema was frozen on the record', () => {
  it('falls back to the shared table so nothing regresses', () => {
    expect(sheetFieldDefinitions(sheet(undefined), '7', SHARED_TABLE_AFTER_B).map(f => f.key))
      .toEqual(['Temperature', 'Pressure', 'Status'])
  })

  it('treats an empty array the same as absent', () => {
    expect(sheetFieldDefinitions(sheet([]), '7', SHARED_TABLE_AFTER_B)).toHaveLength(3)
  })

  it('is reported honestly by hasOwnFieldDefinitions', () => {
    expect(hasOwnFieldDefinitions(sheet(SHEET_A_PUMP))).toBe(true)
    expect(hasOwnFieldDefinitions(sheet([]))).toBe(false)
    expect(hasOwnFieldDefinitions(sheet(undefined))).toBe(false)
    expect(hasOwnFieldDefinitions(null)).toBe(false)
  })
})

describe('guards', () => {
  it('returns nothing without a class id', () => {
    expect(sheetFieldDefinitions(sheet(SHEET_A_PUMP), undefined, SHARED_TABLE_AFTER_B)).toEqual([])
  })

  it('survives a null sheet', () => {
    expect(sheetFieldDefinitions(null, '7', SHARED_TABLE_AFTER_B)).toHaveLength(3)
  })
})
