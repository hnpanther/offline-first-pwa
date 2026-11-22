import { db } from '@/services/storage/db'
import type { CachedFormDefinition } from '@/types'

export async function putFormDefinitions(forms: CachedFormDefinition[]): Promise<void> {
  if (forms.length === 0) return
  await db.formDefinitions.bulkPut(forms)
}

/**
 * Every cached fillable form, title-sorted in memory.
 *
 * Dexie v5 indexes only `id` and `code` — never `title`. `orderBy('title')` throws a SchemaError
 * (Dexie warns that the key path is not indexed), FormListPage's catch leaves `forms` at `[]`,
 * and the catalog looks empty while `get(id)` deep-links still work. Do not reintroduce
 * `orderBy('title')` without a new Dexie version that adds the index.
 */
export async function getAllFormDefinitions(): Promise<CachedFormDefinition[]> {
  const rows = await db.formDefinitions.toArray()
  return rows.sort((a, b) => (a.title || a.code || '').localeCompare(b.title || b.code || ''))
}

export async function getFormDefinition(id: string): Promise<CachedFormDefinition | undefined> {
  return db.formDefinitions.get(id)
}

export async function replaceFormDefinitions(forms: CachedFormDefinition[]): Promise<void> {
  await db.transaction('rw', db.formDefinitions, async () => {
    await db.formDefinitions.clear()
    if (forms.length > 0) await db.formDefinitions.bulkPut(forms)
  })
}
