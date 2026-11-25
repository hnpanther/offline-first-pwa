import type { FieldDefinition } from '@/types/sync'
import { lookupChoices } from './lookupValue'

/** Undefined is independent; an empty array means a parent field exists but is unanswered. */
export function lookupParentCodes(
  field: FieldDefinition,
  siblings: FieldDefinition[],
  answers: Record<string, unknown> | undefined
): string[] | undefined {
  const parentList = field.validation?.lookupParentList?.trim().toLowerCase()
  if (!field.validation?.lookupFilterByParent || !parentList) return undefined
  const parents = siblings.filter(parent => !parent.deleted && parent.key !== field.key &&
    (parent.dataType === 'lookup' || parent.dataType === 'lookupmulti') &&
    parent.validation?.lookupList?.trim().toLowerCase() === parentList)
  if (!parents.length) return undefined
  return [...new Set(parents.flatMap(parent => lookupChoices(answers?.[parent.key])
    .map(choice => choice.code.toLowerCase())))].sort()
}
