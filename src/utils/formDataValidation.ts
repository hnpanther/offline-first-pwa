import { attachmentIdsOf, attachmentKindForDataType } from '@/services/storage/attachments'
import type { LogSheet, LogSheetEntryData } from '@/types'
import type { FieldDefinition } from '@/types/sync'
import { sheetFieldDefinitions } from '@/utils/sheetFieldDefinitions'

/**
 * A client-side mirror of the server's submit validation.
 *
 * <h3>Why this exists</h3>
 * Before this, `canSubmitLogSheet` checked lifecycle state only — cancelled, expired, already
 * submitted — and never looked at the values. So an operator could submit a sheet the server
 * was certain to reject, and then stand at the equipment reading a Persian validation error
 * with nothing they could do about it. The fix is prevention: refuse the submit *here*, while
 * the operator is still in front of the form and can fix it.
 *
 * <h3>The rule that governs every line below</h3>
 * This must never block a submission the server would have accepted. A false block is worse
 * than the bug it replaces: the operator is stuck with no error from anyone and no way forward.
 * So wherever the answer is uncertain — no field definitions for a class, an unrecognised data
 * type — the answer is **allow**, and the server stays the authority.
 *
 * That is why the blankness rules are transcribed from `FormDataValidationSupport.isBlank`
 * rather than reusing `evaluateEntryCompletion`. The two disagree in ways that matter:
 * `isValueFilled` there treats `false` as filled and an emptied attachment reference as filled,
 * both of which the server calls blank — so a required unchecked checkbox would have sailed
 * past this gate and been rejected on arrival, which is the exact trap being closed.
 */

/** Mirrors `FormDataValidationSupport.isBlank(value, dataType)` on the server. */
export function isFieldValueBlank(value: unknown, dataType: string | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0

  const type = (dataType ?? '').trim().toLowerCase()

  if (attachmentKindForDataType(type)) {
    // "Answered" means at least one attachment id. A reference object holding an empty list —
    // what is left after the operator deletes the last photo — is as unanswered as a null.
    return attachmentIdsOf(value).length === 0
  }

  if (type === 'location') {
    return !isUsableCoordinate(value)
  }

  if (type === 'checkbox') {
    if (typeof value === 'boolean') return !value
    const text = String(value).trim().toLowerCase()
    return text === '' || text === 'false' || text === '0'
  }

  return false
}

/** Mirrors the server's `LocationValues.parse` well enough to judge blankness. */
function isUsableCoordinate(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    if (typeof value === 'string') {
      const parts = value.split(',')
      if (parts.length !== 2) return false
      return inRange(Number(parts[0]), Number(parts[1]))
    }
    return false
  }
  const record = value as Record<string, unknown>
  return inRange(Number(record.lat), Number(record.lng))
}

function inRange(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * Mirrors `FormDataValidationSupport.hasMeaningfulFormData`.
 *
 * The server skips required-field checks entirely for an untouched entry, because a multi-asset
 * sheet may legitimately have assets nobody reached. Getting this wrong in the strict direction
 * would block every partially-filled sheet — which operators submit all the time.
 */
export function hasMeaningfulFormData(formData: Record<string, unknown> | undefined): boolean {
  if (!formData) return false
  for (const value of Object.values(formData)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      if (value.trim() !== '') return true
    } else if (Array.isArray(value)) {
      if (value.length > 0) return true
    } else {
      return true
    }
  }
  return false
}

export interface SubmitBlockingIssue {
  assetId: string
  assetName?: string
  /** The field's label, matching what the operator sees on the form. */
  fieldLabel: string
}

/**
 * Required fields the server would reject this sheet for.
 *
 * Only entries the operator actually touched are checked, and only classes whose definitions
 * this device holds — both mirroring the server. An empty result means "nothing we can prove
 * is wrong", not "guaranteed to be accepted".
 */
export function findSubmitBlockingIssues(
  sheet: Pick<LogSheet, 'entries' | 'fieldDefinitions'>,
  fallbackDefs: FieldDefinition[] = []
): SubmitBlockingIssue[] {
  const issues: SubmitBlockingIssue[] = []

  for (const entry of sheet.entries ?? []) {
    if (!hasMeaningfulFormData(entry.formData)) continue

    const defs = sheetFieldDefinitions(sheet as LogSheet, entry.classId, fallbackDefs)
    // No schema for this class on this device: the server validates against its own snapshot
    // and may well accept it. Blocking here would strand the operator over our missing data.
    if (defs.length === 0) continue

    for (const def of defs) {
      if (def.deleted || !def.required) continue
      if (isFieldValueBlank(entry.formData?.[def.key], def.dataType)) {
        issues.push({
          assetId: entry.assetId,
          assetName: entry.assetName,
          fieldLabel: def.label || def.key
        })
      }
    }
  }
  return issues
}

/** A short Persian summary naming the first few offending assets and fields. */
export function describeSubmitBlockingIssues(issues: SubmitBlockingIssue[]): string {
  if (issues.length === 0) return ''
  const shown = issues.slice(0, 3)
  const parts = shown.map(i => `${i.assetName ?? i.assetId}: ${i.fieldLabel}`)
  const more = issues.length > shown.length ? ` و ${issues.length - shown.length} مورد دیگر` : ''
  return `فیلدهای الزامی تکمیل نشده‌اند — ${parts.join('، ')}${more}.`
}

/** Entry helper for the fill page, so an asset card can flag itself before submit. */
export function entryHasBlockingIssues(
  entry: LogSheetEntryData,
  defs: FieldDefinition[]
): boolean {
  if (!hasMeaningfulFormData(entry.formData)) return false
  if (defs.length === 0) return false
  return defs.some(
    def => !def.deleted && def.required && isFieldValueBlank(entry.formData?.[def.key], def.dataType)
  )
}
