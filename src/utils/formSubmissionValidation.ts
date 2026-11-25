import { serverNow } from '@/services/clock/serverClock'
import { dateTimeBoundsError } from './dateTimeBounds'
import { isFieldValueBlank } from '@/utils/formDataValidation'
import { entryLimitError } from '@/utils/fieldValidation'
import type { FieldDefinition } from '@/types/sync'

export interface FormFieldIssue {
  fieldKey: string
  fieldLabel: string
  problem?: string
}

/**
 * Required / entry-limit issues the server would refuse on final form submit.
 * Same blankness rules as log sheets; allow when uncertain (no schema → allow).
 */
export function findFormSubmitBlockingIssues(
  fields: FieldDefinition[],
  formData: Record<string, unknown> | undefined,
  recordedAt = serverNow()
): FormFieldIssue[] {
  if (!fields.length) return []
  const issues: FormFieldIssue[] = []
  for (const def of fields) {
    if (def.deleted) continue
    const value = formData?.[def.key]
    if (def.required && isFieldValueBlank(value, def.dataType)) {
      issues.push({ fieldKey: def.key, fieldLabel: def.label || def.key })
      continue
    }
    if (def.dataType === 'datetime') {
      const problem = dateTimeBoundsError(value, def.validation, recordedAt)
      if (problem) issues.push({ fieldKey: def.key, fieldLabel: def.label || def.key, problem })
    }
    if (def.dataType === 'number' && isPlainNumber(value)) {
      const problem = entryLimitError(value, def.validation)
      if (problem) {
        issues.push({ fieldKey: def.key, fieldLabel: def.label || def.key, problem })
      }
    }
  }
  return issues
}

export function describeFormSubmitBlockingIssues(issues: FormFieldIssue[]): string {
  if (issues.length === 0) return ''
  const missing = issues.filter(i => !i.problem)
  const refused = issues.filter(i => i.problem)
  const parts: string[] = []
  if (missing.length > 0) {
    parts.push(
      `فیلدهای الزامی تکمیل نشده‌اند — ${missing
        .slice(0, 3)
        .map(i => i.fieldLabel)
        .join('، ')}.`
    )
  }
  if (refused.length > 0) {
    parts.push(
      `مقدار خارج از حد مجاز — ${refused
        .slice(0, 3)
        .map(i => `${i.fieldLabel} (${i.problem})`)
        .join('، ')}`
    )
  }
  return parts.join(' ')
}

function isPlainNumber(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string' || value.trim() === '') return false
  return Number.isFinite(Number(value.trim()))
}
