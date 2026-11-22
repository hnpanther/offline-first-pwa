import { db } from '@/services/storage/db'
import type { CachedFormDefinition } from '@/types'

export async function putFormDefinitions(forms: CachedFormDefinition[]): Promise<void> {
  if (forms.length === 0) return
  await db.formDefinitions.bulkPut(forms)
}

export async function getAllFormDefinitions(): Promise<CachedFormDefinition[]> {
  return db.formDefinitions.orderBy('title').toArray()
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
