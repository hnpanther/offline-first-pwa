import { describe, expect, it } from 'vitest'
import { defaultFilingUnit, formFilingUnits } from './formFilingUnits'
import type { OperationalUnit } from '@/types'

const units: OperationalUnit[] = ['A', 'B', 'C'].map(id => ({
  id, code: id, name: id, createdAt: 0, updatedAt: 0
}))

describe('form filing units', () => {
  it('does not choose the primary unit when only another accessible unit is linked', () => {
    const choices = formFilingUnits(units, ['B', 'C'], ['A', 'B'], false)
    expect(choices.map(unit => unit.id)).toEqual(['B'])
    expect(defaultFilingUnit(choices, 'A')).toBe('B')
  })
  it('keeps the primary unit when it is allowed', () => {
    expect(defaultFilingUnit(formFilingUnits(units, ['A', 'B'], ['A', 'B'], false), 'B')).toBe('B')
  })
  it('does not widen missing cached scope to every unit', () => {
    expect(formFilingUnits(units, ['A'], [], false)).toEqual([])
    expect(defaultFilingUnit([], 'A')).toBe('')
  })
  it('plant-wide scope still requires the form unit link', () => {
    expect(formFilingUnits(units, ['B'], [], true).map(unit => unit.id)).toEqual(['B'])
  })
})
