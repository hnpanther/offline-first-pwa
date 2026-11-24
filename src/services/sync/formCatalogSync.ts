import { fetchFillableForms } from '@/services/api'
import { replaceFormDefinitions } from '@/services/storage/formDefinitions'
import { mapFormFieldSnapshots, mapRequiredLookups } from '@/services/forms/mapFormFields'
import { toIdString } from '@/utils/ids'
import type { CachedFormDefinition } from '@/types'

/**
 * Pulls fillable form definitions into IndexedDB so offline create still has a schema.
 * Never throws — a catalog failure must not break inbox / log-sheet sync.
 */
export async function pullFillableForms(signal?: AbortSignal): Promise<CachedFormDefinition[]> {
  try {
    const dtos = await fetchFillableForms(signal)
    const forms: CachedFormDefinition[] = dtos.map(dto => ({
      id: toIdString(dto.id),
      schemaVersionId: dto.schemaVersionId != null ? toIdString(dto.schemaVersionId) : undefined,
      code: dto.code,
      title: dto.title,
      description: dto.description,
      active: dto.active !== false,
      subjectUnitIds: (dto.subjectUnitIds ?? []).map(toIdString),
      fields: mapFormFieldSnapshots(dto.fields),
      requiredLookups: mapRequiredLookups(dto.requiredLookups),
      fetchedAt: Date.now()
    }))
    await replaceFormDefinitions(forms)
    return forms
  } catch (err) {
    console.warn('Fillable form catalog pull failed', err)
    return []
  }
}
