import { toIdString } from '@/utils/ids'
import type { FieldDefinition, FieldDataType } from '@/types/sync'
import type { LocalFormSubmission } from '@/types'
import type { RequiredLookup } from '@/services/api'

/** Wire shape of a field on GET /api/forms and form submission snapshots. */
export interface FormFieldSnapshotDto {
  id?: string | number
  classId?: string | number | null
  key: string
  label: string
  dataType: string
  unit?: string | null
  required?: boolean
  validation?: FieldDefinition['validation']
  order?: number | null
  version?: number | null
  deleted?: boolean
}

/**
 * Maps a server field snapshot into the PWA's FieldDefinition.
 *
 * Forms have no asset class — `classId` may be null. DynamicClassForm only needs key/label/
 * dataType/required/validation/order, so an empty classId is fine.
 */
export function mapFormFieldSnapshot(dto: FormFieldSnapshotDto, index = 0): FieldDefinition {
  return {
    id: dto.id != null ? toIdString(dto.id) : `form-field-${dto.key}-${index}`,
    classId: dto.classId != null ? toIdString(dto.classId) : '',
    key: dto.key,
    label: dto.label,
    dataType: (dto.dataType ?? 'text') as FieldDataType,
    unit: dto.unit ?? undefined,
    required: dto.required === true,
    validation: dto.validation,
    order: typeof dto.order === 'number' ? dto.order : index,
    version: typeof dto.version === 'number' ? dto.version : 1,
    deleted: dto.deleted === true,
    synced: true,
    createdAt: 0,
    updatedAt: 0
  }
}

export function mapFormFieldSnapshots(fields: FormFieldSnapshotDto[] | null | undefined): FieldDefinition[] {
  return (fields ?? []).map((f, i) => mapFormFieldSnapshot(f, i))
}

export function mapRequiredLookups(
  rows: Array<{ code: string; name: string; revision: number }> | null | undefined
): RequiredLookup[] {
  return (rows ?? [])
    .filter(r => r && typeof r.code === 'string' && r.code.trim() !== '')
    .map(r => ({
      code: r.code,
      name: r.name ?? r.code,
      revision: typeof r.revision === 'number' ? r.revision : 0
    }))
}

/** Legacy devices kept the field definition but had no published version id. */
export function formSchemaEvidence(row: Pick<LocalFormSubmission,
  'schemaVersionId' | 'fieldDefinitionsSnapshot'>) {
  if (row.schemaVersionId != null) return { schemaVersionId: row.schemaVersionId }
  return { legacyFields: row.fieldDefinitionsSnapshot?.map(field => ({
    id: /^\d+$/.test(field.id) ? field.id : undefined,
    key: field.key, label: field.label, dataType: field.dataType,
    unit: field.unit, required: field.required, validation: field.validation,
    order: field.order, version: field.version
  })) }
}
