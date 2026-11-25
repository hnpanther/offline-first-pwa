import { describe, expect, it } from 'vitest'
import type { FieldDefinition } from '@/types/sync'
import { lookupParentCodes } from './lookupParent'

const field = (key: string, validation: FieldDefinition['validation'] = {}): FieldDefinition => ({
  id: key, classId: '', key, label: key, dataType: 'lookup', validation,
  required: false, order: 0, version: 1, deleted: false, synced: true, createdAt: 0, updatedAt: 0
})
const parent = field('management', { lookupList: 'Managers' })
const child = field('unit', { lookupList: 'Units', lookupFilterByParent: true, lookupParentList: 'managers' })

describe('lookup parent selection', () => {
  it('is independent without a configured parent or matching sibling', () => {
    expect(lookupParentCodes(child, [child], {})).toBeUndefined()
    expect(lookupParentCodes(field('x', { lookupFilterByParent: true }), [field('y')], {})).toBeUndefined()
    expect(lookupParentCodes(field('x', { lookupParentList: 'Managers' }), [parent], {})).toBeUndefined()
  })
  it('distinguishes unanswered parents and unions multiple selections without duplicates', () => {
    expect(lookupParentCodes(child, [child, parent], {})).toEqual([])
    const second = field('other', { lookupList: 'Managers' })
    expect(lookupParentCodes(child, [child, parent, second], {
      management: [{ code: 'A' }, { code: 'B' }], other: { code: 'a' }
    })).toEqual(['a', 'b'])
    expect(lookupParentCodes(child, [child, parent], { management: { code: 'C' } })).toEqual(['c'])
  })
})
