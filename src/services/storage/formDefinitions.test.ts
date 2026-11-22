import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/services/storage/db'
import {
  getAllFormDefinitions,
  getFormDefinition,
  replaceFormDefinitions
} from '@/services/storage/formDefinitions'
import type { CachedFormDefinition } from '@/types'

function form(overrides: Partial<CachedFormDefinition> & Pick<CachedFormDefinition, 'id' | 'title'>): CachedFormDefinition {
  return {
    code: overrides.code ?? `CODE-${overrides.id}`,
    active: true,
    subjectUnitIds: [],
    fields: [],
    fetchedAt: 1,
    ...overrides
  }
}

beforeEach(async () => {
  if (!db.isOpen()) await db.open()
  await db.formDefinitions.clear()
})

describe('formDefinitions catalog read', () => {
  it('lists fillable forms after replace without requiring a title index', async () => {
    // Schema is `id, code` only — the regression that emptied /forms was orderBy('title').
    const table = db.tables.find(t => t.name === 'formDefinitions')
    expect(table).toBeDefined()
    expect(table!.schema.indexes.map(i => i.name)).not.toContain('title')

    await replaceFormDefinitions([
      form({ id: '2', title: 'بتا', code: 'B' }),
      form({ id: '1', title: 'آلفا', code: 'A', active: true }),
      form({ id: '3', title: 'گاما', code: 'C', active: false })
    ])

    const listed = await getAllFormDefinitions()
    expect(listed.map(f => f.id)).toEqual(['1', '2', '3'])
    expect(listed.map(f => f.title)).toEqual(['آلفا', 'بتا', 'گاما'])
    // Deep-link path that kept working while the list was empty.
    expect((await getFormDefinition('1'))?.code).toBe('A')
  })

  it('still returns cached rows when the catalog was written by an earlier pull', async () => {
    await replaceFormDefinitions([form({ id: '9', title: 'HSE', code: 'HSE-1' })])
    expect(await getAllFormDefinitions()).toHaveLength(1)
    expect((await getAllFormDefinitions())[0].code).toBe('HSE-1')
  })
})
