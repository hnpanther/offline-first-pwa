import { describe, expect, it } from 'vitest'
import { toFormFields } from '@/services/storage/fieldDefinitions'

describe('toFormFields', () => {
  it('maps server FieldDefinition-shaped embeds to FormField', () => {
    const fields = toFormFields([
      { id: 1, key: 'temp', label: 'Temperature', dataType: 'number', required: true },
      { id: 2, key: 'Bar', label: 'Bar', dataType: 'number', required: false }
    ])

    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatchObject({ name: 'temp', type: 'number', label: 'Temperature' })
    expect(fields[1]).toMatchObject({ name: 'Bar', type: 'number', label: 'Bar' })
  })

  it('keeps local FormField shape', () => {
    const fields = toFormFields([
      { name: 'status', label: 'Status', type: 'select', required: true, options: [{ value: 'ok', label: 'OK' }] }
    ])

    expect(fields).toEqual([
      expect.objectContaining({
        name: 'status',
        type: 'select',
        label: 'Status',
        required: true
      })
    ])
  })

  it('drops embeds without name/key so sync cannot invent blank keys', () => {
    expect(toFormFields([{ label: 'Broken', dataType: 'text' }])).toEqual([])
  })
})
