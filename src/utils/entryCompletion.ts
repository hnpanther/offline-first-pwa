import type { LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'

function isValueFilled(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export interface EntryCompletionState {
  filledCount: number
  totalCount: number
  requiredCount: number
  filledRequiredCount: number
  hasData: boolean
  isComplete: boolean
}

/** Completion based on FieldDefinition rows (not legacy AssetClass.fields). */
export function evaluateEntryCompletion(
  entry: LogSheetEntryData,
  fieldDefs: FieldDefinition[]
): EntryCompletionState {
  const activeDefs = fieldDefs.filter(d => !d.deleted)
  const totalCount = activeDefs.length

  if (totalCount === 0) {
    const filledCount = Object.values(entry.formData ?? {}).filter(isValueFilled).length
    const hasData = filledCount > 0
    return {
      filledCount,
      totalCount: 0,
      requiredCount: 0,
      filledRequiredCount: 0,
      hasData,
      isComplete: hasData
    }
  }

  let filledCount = 0
  let requiredCount = 0
  let filledRequiredCount = 0

  for (const def of activeDefs) {
    const filled = isValueFilled(entry.formData?.[def.key])
    if (filled) filledCount++
    if (def.required) {
      requiredCount++
      if (filled) filledRequiredCount++
    }
  }

  const hasData = filledCount > 0
  const isComplete =
    requiredCount > 0 ? filledRequiredCount >= requiredCount : hasData

  return {
    filledCount,
    totalCount,
    requiredCount,
    filledRequiredCount,
    hasData,
    isComplete
  }
}
